import { InteractionControllerError } from "@opengeni/interaction";

export type WindowsSeatStatus = {
  sessionId: number;
  windowStation: string;
  desktop: string;
  inputDesktop: string | null;
};

export type WindowsSeat = { seatId: string; displayId: string };

const UOI_NAME = 2;
const DESKTOP_READOBJECTS = 0x0001;

/**
 * Read this process's Windows session, window station and desktop, plus the
 * desktop currently receiving input, straight from kernel32/user32. A
 * service/SSH Session 0 is never treated as a login seat, and nothing is
 * launched or changed. Direct calls take milliseconds; a PowerShell probe can
 * spend half a minute preparing modules on first use.
 */
export async function readWindowsSeat(): Promise<WindowsSeat> {
  let status: WindowsSeatStatus;
  try {
    status = await readWindowsSeatStatus();
  } catch {
    throw unavailable();
  }
  return windowsSeatFromStatus(status);
}

export function windowsSeatFromStatus(status: WindowsSeatStatus): WindowsSeat {
  if (
    !Number.isSafeInteger(status.sessionId) ||
    status.sessionId <= 0 ||
    status.windowStation !== "WinSta0" ||
    status.desktop !== "Default" ||
    status.inputDesktop !== "Default"
  ) {
    throw unavailable();
  }
  return {
    seatId: `windows-login-seat:${status.sessionId}`,
    displayId: `windows:${status.sessionId}:WinSta0/Default`,
  };
}

async function readWindowsSeatStatus(): Promise<WindowsSeatStatus> {
  const { dlopen, FFIType } = await import("bun:ffi");
  const kernel32 = dlopen("kernel32.dll", {
    GetCurrentProcessId: { args: [], returns: FFIType.u32 },
    GetCurrentThreadId: { args: [], returns: FFIType.u32 },
    ProcessIdToSessionId: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const user32 = dlopen("user32.dll", {
    GetProcessWindowStation: { args: [], returns: FFIType.ptr },
    GetThreadDesktop: { args: [FFIType.u32], returns: FFIType.ptr },
    OpenInputDesktop: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
    CloseDesktop: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetUserObjectInformationW: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  try {
    const k = kernel32.symbols;
    const u = user32.symbols;
    const session = new Uint32Array(1);
    if (!k.ProcessIdToSessionId(k.GetCurrentProcessId(), session)) {
      throw new Error("session unavailable");
    }
    const name = (handle: unknown): string => {
      if (!handle) throw new Error("user object unavailable");
      const buffer = new Uint16Array(256);
      const needed = new Uint32Array(1);
      if (
        !u.GetUserObjectInformationW(handle as never, UOI_NAME, buffer, buffer.byteLength, needed)
      ) {
        throw new Error("user object name unavailable");
      }
      const end = buffer.indexOf(0);
      return new TextDecoder("utf-16le").decode(buffer.subarray(0, end < 0 ? buffer.length : end));
    };
    const windowStation = name(u.GetProcessWindowStation());
    const desktop = name(u.GetThreadDesktop(k.GetCurrentThreadId()));
    // The input desktop is unreadable while the screen is locked or a secure
    // desktop (UAC, Ctrl+Alt+Del) is showing.
    const input = u.OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
    let inputDesktop: string | null = null;
    if (input) {
      try {
        inputDesktop = name(input);
      } finally {
        u.CloseDesktop(input);
      }
    }
    return { sessionId: session[0] ?? 0, windowStation, desktop, inputDesktop };
  } finally {
    kernel32.close();
    user32.close();
  }
}

function unavailable() {
  return new InteractionControllerError(
    "resource_unavailable",
    "Windows CUA requires an unlocked interactive user session on WinSta0/Default",
    true,
  );
}
