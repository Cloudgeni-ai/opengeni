//! The current user's registry: the default value of one key.
//!
//! Chromium-family browsers on Windows find a Native Messaging host through the
//! default value of `HKEY_CURRENT_USER\Software\<browser>\NativeMessagingHosts\<name>`,
//! which names the host's manifest file. That is all the agent writes, so this
//! module covers exactly that: read, write and delete one key's default string.

use std::io;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyW, RegGetValueW, RegOpenKeyExW, RegSetKeyValueW, HKEY,
    HKEY_CURRENT_USER, KEY_READ, REG_SZ, RRF_RT_REG_SZ,
};

fn wide(value: &str) -> io::Result<Vec<u16>> {
    if value.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "registry strings cannot contain NUL",
        ));
    }
    Ok(value.encode_utf16().chain(std::iter::once(0)).collect())
}

fn check(status: WIN32_ERROR) -> io::Result<()> {
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(i32::MAX),
        ))
    }
}

pub(crate) fn key_exists(subkey: &str) -> io::Result<bool> {
    let subkey = wide(subkey)?;
    let mut key: HKEY = null_mut();
    // SAFETY: `subkey` is NUL-terminated and outlives the call; `key` is a valid
    // out pointer.
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_READ,
            &raw mut key,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(false);
    }
    check(status)?;
    // SAFETY: the key was opened above and is closed exactly once.
    unsafe { RegCloseKey(key) };
    Ok(true)
}

pub(crate) fn default_value(subkey: &str) -> io::Result<Option<String>> {
    let subkey = wide(subkey)?;
    let mut bytes = 0_u32;
    // SAFETY: a size query: no data buffer, `bytes` is a valid out pointer.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            null(),
            RRF_RT_REG_SZ,
            null_mut(),
            null_mut(),
            &raw mut bytes,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    check(status)?;
    let mut buffer = vec![0_u16; (bytes as usize).div_ceil(2).max(1)];
    let mut written = u32::try_from(buffer.len() * 2).unwrap_or(u32::MAX);
    // SAFETY: `buffer` holds `written` bytes and outlives the call.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            null(),
            RRF_RT_REG_SZ,
            null_mut(),
            buffer.as_mut_ptr().cast(),
            &raw mut written,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    check(status)?;
    buffer.truncate((written as usize) / 2);
    while buffer.last() == Some(&0) {
        buffer.pop();
    }
    Ok(Some(String::from_utf16_lossy(&buffer)))
}

pub(crate) fn set_default_value(subkey: &str, value: &str) -> io::Result<()> {
    let subkey = wide(subkey)?;
    let value = wide(value)?;
    let bytes = u32::try_from(value.len() * 2)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "registry value too long"))?;
    // SAFETY: both strings are NUL-terminated and outlive the call; `bytes`
    // is the exact size of `value` including its terminator. The key is
    // created when missing.
    check(unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            null(),
            REG_SZ,
            value.as_ptr().cast(),
            bytes,
        )
    })
}

pub(crate) fn delete_key(subkey: &str) -> io::Result<()> {
    let subkey = wide(subkey)?;
    // SAFETY: `subkey` is NUL-terminated and outlives the call.
    let status = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, subkey.as_ptr()) };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    check(status)
}

#[cfg(test)]
mod tests {
    use super::{default_value, delete_key, key_exists, set_default_value};

    #[test]
    fn writes_reads_and_deletes_one_default_value() {
        let parent = format!(r"Software\OpengeniAgentTest-{}", std::process::id());
        let key = format!(r"{parent}\NativeMessagingHosts\ai.opengeni.browser");
        assert!(!key_exists(&key).expect("query"));
        assert_eq!(default_value(&key).expect("read missing"), None);

        let manifest =
            r"C:\Users\Jørgen\AppData\Local\Opengeni\NativeMessagingHosts\ai.opengeni.browser.json";
        set_default_value(&key, manifest).expect("write");
        assert!(key_exists(&key).expect("query"));
        assert_eq!(
            default_value(&key).expect("read").as_deref(),
            Some(manifest)
        );

        delete_key(&key).expect("delete");
        delete_key(&key).expect("delete is idempotent");
        assert!(!key_exists(&key).expect("query"));
        for ancestor in [format!(r"{parent}\NativeMessagingHosts"), parent] {
            delete_key(&ancestor).expect("cleanup");
        }
    }
}
