//! Owned Windows job handles: exact membership and process-zero receipts.

use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use std::sync::Arc;
use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenThread, ResumeThread, CREATE_SUSPENDED, INFINITE, PROCESS_SET_QUOTA,
    PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};
use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus};

#[derive(Clone)]
/// A private kill-on-close job and its completion port. Clones share ownership,
/// so cancelling an async waiter cannot invalidate a blocking kernel wait.
pub struct ProcessJob {
    job: Arc<OwnedHandle>,
    port: Arc<OwnedHandle>,
}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: each successful creation/open transfers one unique handle here.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn success(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

impl ProcessJob {
    /// Spawn flag used until the child has joined this job.
    pub const SUSPENDED: u32 = CREATE_SUSPENDED;

    /// Creates the same kill-on-close containment used for command cancellation.
    /// No CPU, memory or process limits are configured.
    ///
    /// # Errors
    /// Returns kernel creation/configuration errors; all created handles close.
    pub fn new() -> io::Result<Self> {
        // SAFETY: null security/name pointers request unnamed noninheritable handles.
        let job = Arc::new(owned(unsafe { CreateJobObjectW(null(), null()) })?);
        // SAFETY: INVALID_HANDLE_VALUE creates a completion port without a file.
        let port = Arc::new(owned(unsafe {
            CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1)
        })?);
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: job.as_raw_handle(),
            CompletionPort: port.as_raw_handle(),
        };
        // SAFETY: both handles are live and the input record matches its class/size.
        success(unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectAssociateCompletionPortInformation,
                std::ptr::from_ref(&association).cast(),
                u32::try_from(size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>())
                    .map_err(io::Error::other)?,
            )
        })?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the record and size match the requested information class.
        success(unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .map_err(io::Error::other)?,
            )
        })?;
        Ok(Self { job, port })
    }

    /// Assigns a newly spawned, still-suspended child before allowing user code.
    /// The caller retains the child's process handle, preventing PID reuse.
    ///
    /// # Errors
    /// Returns assignment/resume errors. The caller must kill its suspended child.
    pub fn assign_and_resume(&self, pid: u32) -> io::Result<()> {
        // SAFETY: OpenProcess validates the ID and requested access in the kernel.
        let process = owned(unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) })?;
        // SAFETY: both handles remain owned for the complete call.
        success(unsafe {
            AssignProcessToJobObject(self.job.as_raw_handle(), process.as_raw_handle())
        })?;
        // SAFETY: snapshot returns an owned read-only thread inventory handle.
        let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
        let mut entry = THREADENTRY32 {
            dwSize: u32::try_from(size_of::<THREADENTRY32>()).map_err(io::Error::other)?,
            ..Default::default()
        };
        let mut resumed = false;
        // SAFETY: entry is initialized to the documented structure size.
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &raw mut entry) };
        while found != 0 {
            if entry.th32OwnerProcessID == pid {
                // SAFETY: the snapshot ID is validated by OpenThread.
                let thread =
                    owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) })?;
                // SAFETY: thread is an owned live handle with resume access.
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                resumed = true;
            }
            // SAFETY: entry remains writable and the snapshot remains open.
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &raw mut entry) };
        }
        let error = io::Error::last_os_error();
        if error
            .raw_os_error()
            .and_then(|code| u32::try_from(code).ok())
            != Some(ERROR_NO_MORE_FILES)
        {
            return Err(error);
        }
        if !resumed {
            return Err(io::Error::other(
                "suspended command has no resumable thread",
            ));
        }
        Ok(())
    }

    /// Reads the job's kernel-owned live-process count.
    ///
    /// # Errors
    /// Returns the native query error, never a fabricated zero count.
    pub fn active_processes(&self) -> io::Result<u32> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: output storage and size match this information class.
        success(unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                std::ptr::from_mut(&mut info).cast(),
                u32::try_from(size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>())
                    .map_err(io::Error::other)?,
                null_mut(),
            )
        })?;
        Ok(info.ActiveProcesses)
    }

    /// Terminates exactly this job, including descendants of an exited leader.
    ///
    /// # Errors
    /// Returns the kernel's termination error.
    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: this handle belongs to this private job, not a numeric PID.
        success(unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) })
    }

    /// Blocks until the kernel reports no live processes in this job. Other
    /// completion messages are wake hints, never mistaken for process-zero.
    ///
    /// # Errors
    /// Returns query/completion-port failures without claiming cleanup finished.
    pub fn wait_empty(&self) -> io::Result<()> {
        while self.active_processes()? != 0 {
            let mut code = 0;
            let mut key = 0;
            let mut overlapped = null_mut();
            // SAFETY: output pointers are live; the job's port stays owned by self.
            success(unsafe {
                GetQueuedCompletionStatus(
                    self.port.as_raw_handle(),
                    &raw mut code,
                    &raw mut key,
                    &raw mut overlapped,
                    INFINITE,
                )
            })?;
        }
        Ok(())
    }
}
