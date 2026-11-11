//! The user a pager runs as once it holds what it needs.
//!
//! A pager is started by the host agent, as root, because it must bind its
//! sockets where the agent and the VMM find them and open the memory image.
//! Everything after that, the guest's page faults above all, needs no
//! privilege: the userfaultfd it receives from the VMM acts on the VMM's
//! memory whoever holds it. So it becomes the VM's own user before it
//! serves anything, and can then reach no more of the host than the VMM.

use std::fmt;
use std::io;
use std::str::FromStr;

use nix::unistd::{Gid, Uid, getresgid, getresuid, setgroups, setresgid, setresuid};

/// A VM's user and group ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct User {
    pub uid: u32,
    pub gid: u32,
}

impl FromStr for User {
    type Err = String;

    /// Reads `UID:GID`.
    fn from_str(text: &str) -> Result<Self, String> {
        let invalid = || format!("{text:?} is not UID:GID");
        let (uid, gid) = text.split_once(':').ok_or_else(invalid)?;
        Ok(Self {
            uid: uid.parse().map_err(|_| invalid())?,
            gid: gid.parse().map_err(|_| invalid())?,
        })
    }
}

impl fmt::Display for User {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.uid, self.gid)
    }
}

impl User {
    /// Makes this process `self` for good: no supplementary groups, the
    /// real, effective and saved ids all `self`'s, so there is no way back;
    /// no capabilities, which leaving uid 0 clears; and no new privileges
    /// from anything it might execute. Call it while the process has a
    /// single thread, before anything it serves can reach it.
    ///
    /// # Errors
    ///
    /// `self` is root, or a change fails or does not hold.
    pub fn assume(self) -> io::Result<()> {
        if self.uid == 0 || self.gid == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("a pager does not run as {self}, which is root"),
            ));
        }
        let (uid, gid) = (Uid::from_raw(self.uid), Gid::from_raw(self.gid));
        setgroups(&[])?;
        setresgid(gid, gid, gid)?;
        setresuid(uid, uid, uid)?;
        nix::sys::prctl::set_no_new_privs()?;
        let uids = getresuid()?;
        let gids = getresgid()?;
        let same_user = [uids.real, uids.effective, uids.saved] == [uid; 3]
            && [gids.real, gids.effective, gids.saved] == [gid; 3];
        let capabilities = std::fs::read_to_string("/proc/self/status")?;
        let none = capabilities.lines().all(|line| {
            ["CapInh:", "CapPrm:", "CapEff:", "CapAmb:"]
                .iter()
                .all(|name| {
                    line.strip_prefix(name)
                        .is_none_or(|value| value.trim().trim_start_matches('0').is_empty())
                })
        });
        if !same_user || !none {
            return Err(io::Error::other(format!(
                "still privileged after becoming {self}"
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_user_reads_back_as_written() {
        let user: User = "1073741843:1073741843".parse().unwrap();
        assert_eq!(
            user,
            User {
                uid: 1_073_741_843,
                gid: 1_073_741_843
            }
        );
        assert_eq!(user.to_string().parse::<User>().unwrap(), user);
        assert!("1000".parse::<User>().is_err());
        assert!("a:1".parse::<User>().is_err());
    }

    #[test]
    fn root_is_refused() {
        let root = User { uid: 0, gid: 0 };
        assert_eq!(
            root.assume().unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
