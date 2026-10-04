import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { InteractionControllerError } from "@opengeni/interaction";

const execute = promisify(execFile);

// Read the inherited process session and desktop. An SSH/service Session 0 is
// never treated as a login seat, and no launcher or permission change occurs.
const probe = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class CuaDesktopSeat {
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
 [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,uint length,out uint needed);
 public static string Name(IntPtr handle) { var value=new StringBuilder(256);uint needed;if(handle==IntPtr.Zero||!GetUserObjectInformation(handle,2,value,512,out needed))throw new Exception("Desktop unavailable");return value.ToString(); }
}
'@
$inputDesktop=[CuaDesktopSeat]::OpenInputDesktop(0,$false,1)
try {
 @{sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;
   windowStation=[CuaDesktopSeat]::Name([CuaDesktopSeat]::GetProcessWindowStation());
   desktop=[CuaDesktopSeat]::Name([CuaDesktopSeat]::GetThreadDesktop([CuaDesktopSeat]::GetCurrentThreadId()));
   inputDesktop=[CuaDesktopSeat]::Name($inputDesktop)} | ConvertTo-Json -Compress
} finally { if($inputDesktop -ne [IntPtr]::Zero){[CuaDesktopSeat]::CloseDesktop($inputDesktop)|Out-Null} }
`;

export async function readWindowsSeat(environment: NodeJS.ProcessEnv) {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (!systemRoot) throw unavailable();
  try {
    const { stdout } = await execute(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(probe, "utf16le").toString("base64"),
      ],
      { env: environment, timeout: 10_000, maxBuffer: 4096, windowsHide: true },
    );
    const status = JSON.parse(stdout.trim());
    if (
      !Number.isSafeInteger(status.sessionId) ||
      status.sessionId <= 0 ||
      status.windowStation !== "WinSta0" ||
      status.desktop !== "Default" ||
      status.inputDesktop !== "Default"
    )
      throw unavailable();
    return {
      seatId: `windows-login-seat:${status.sessionId}`,
      displayId: `windows:${status.sessionId}:WinSta0/Default`,
    };
  } catch {
    throw unavailable();
  }
}

function unavailable() {
  return new InteractionControllerError(
    "resource_unavailable",
    "Windows CUA requires an unlocked interactive user session on WinSta0/Default",
    true,
  );
}
