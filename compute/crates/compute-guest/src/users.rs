//! Finding who an image's `USER` names, in the image's own account files,
//! as container runtimes do: a name must have an account; a number need
//! not, and then runs with group 0 and home `/`.

/// One line of `/etc/passwd`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
}

/// One line of `/etc/group`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub name: String,
    pub gid: u32,
    pub members: Vec<String>,
}

/// Who a process runs as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub uid: u32,
    pub gid: u32,
    /// Supplementary groups, the primary one first.
    pub groups: Vec<u32>,
    pub home: String,
    /// The account's name, if it has one.
    pub name: Option<String>,
}

/// Parses `/etc/passwd`, skipping lines it cannot read.
#[must_use]
pub fn parse_passwd(text: &str) -> Vec<Account> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            let [name, _, uid, gid, _, home, ..] = fields.as_slice() else {
                return None;
            };
            Some(Account {
                name: (*name).to_owned(),
                uid: uid.parse().ok()?,
                gid: gid.parse().ok()?,
                home: (*home).to_owned(),
            })
        })
        .collect()
}

/// Parses `/etc/group`, skipping lines it cannot read.
#[must_use]
pub fn parse_group(text: &str) -> Vec<Group> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            let [name, _, gid, members, ..] = fields.as_slice() else {
                return None;
            };
            Some(Group {
                name: (*name).to_owned(),
                gid: gid.parse().ok()?,
                members: members
                    .split(',')
                    .filter(|m| !m.is_empty())
                    .map(str::to_owned)
                    .collect(),
            })
        })
        .collect()
}

/// Why a `USER` could not be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserError {
    NoSuchUser(String),
    NoSuchGroup(String),
}

impl std::fmt::Display for UserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoSuchUser(name) => write!(f, "no account named {name:?}"),
            Self::NoSuchGroup(name) => write!(f, "no group named {name:?}"),
        }
    }
}

impl std::error::Error for UserError {}

/// Resolves `USER` (`user`, `uid`, `user:group` or `uid:gid`; empty for
/// root) against the image's accounts and groups.
pub fn resolve(spec: &str, accounts: &[Account], groups: &[Group]) -> Result<Identity, UserError> {
    let (user, group) = match spec.split_once(':') {
        Some((user, group)) => (user, Some(group)),
        None => (spec, None),
    };
    let user = if user.is_empty() { "0" } else { user };
    let account = match user.parse::<u32>() {
        Ok(uid) => accounts.iter().find(|a| a.uid == uid),
        Err(_) => Some(
            accounts
                .iter()
                .find(|a| a.name == user)
                .ok_or_else(|| UserError::NoSuchUser(user.to_owned()))?,
        ),
    };
    let uid = account.map_or_else(|| user.parse().unwrap_or(0), |a| a.uid);
    let gid = match group.filter(|g| !g.is_empty()) {
        None => account.map_or(0, |a| a.gid),
        Some(group) => match group.parse::<u32>() {
            Ok(gid) => gid,
            Err(_) => {
                groups
                    .iter()
                    .find(|g| g.name == group)
                    .ok_or_else(|| UserError::NoSuchGroup(group.to_owned()))?
                    .gid
            }
        },
    };
    let mut supplementary = vec![gid];
    if let Some(account) = account {
        for group in groups.iter().filter(|g| g.members.contains(&account.name)) {
            if !supplementary.contains(&group.gid) {
                supplementary.push(group.gid);
            }
        }
    }
    Ok(Identity {
        uid,
        gid,
        groups: supplementary,
        home: account.map_or_else(|| "/".to_owned(), |a| a.home.clone()),
        name: account.map(|a| a.name.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWD: &str = "root:x:0:0:root:/root:/bin/bash\n\
        daemon:x:1:1::/usr/sbin:/usr/sbin/nologin\n\
        broken line\n\
        user:x:1000:1000:,,,:/home/user:/bin/bash\n\
        node:x:1001:1001::/home/node:/bin/sh\n";
    const GROUP: &str =
        "root:x:0:\nsudo:x:27:user,node\nuser:x:1000:\ndocker:x:999:user\nbad\nnode:x:1001:\n";

    fn resolve_in(spec: &str) -> Result<Identity, UserError> {
        resolve(spec, &parse_passwd(PASSWD), &parse_group(GROUP))
    }

    #[test]
    fn parses_account_files_and_skips_bad_lines() {
        let accounts = parse_passwd(PASSWD);
        assert_eq!(accounts.len(), 4);
        assert_eq!(accounts[2].home, "/home/user");
        let groups = parse_group(GROUP);
        assert_eq!(groups.len(), 5);
        assert_eq!(groups[1].members, ["user", "node"]);
        assert_eq!(groups[0].members, Vec::<String>::new());
    }

    #[test]
    fn empty_is_root() {
        let root = resolve_in("").unwrap();
        assert_eq!((root.uid, root.gid, root.home.as_str()), (0, 0, "/root"));
        assert_eq!(root.name.as_deref(), Some("root"));
    }

    #[test]
    fn names_take_the_accounts_group_and_memberships() {
        let user = resolve_in("user").unwrap();
        assert_eq!((user.uid, user.gid), (1000, 1000));
        assert_eq!(user.groups, [1000, 27, 999]);
        assert_eq!(user.home, "/home/user");
    }

    #[test]
    fn numbers_need_no_account() {
        let known = resolve_in("1001").unwrap();
        assert_eq!((known.gid, known.name.as_deref()), (1001, Some("node")));
        let unknown = resolve_in("4242").unwrap();
        assert_eq!(
            unknown,
            Identity {
                uid: 4242,
                gid: 0,
                groups: vec![0],
                home: "/".into(),
                name: None,
            }
        );
    }

    #[test]
    fn groups_by_name_or_number() {
        let user = resolve_in("user:docker").unwrap();
        assert_eq!((user.uid, user.gid), (1000, 999));
        assert_eq!(user.groups, [999, 27]);
        assert_eq!(resolve_in("4242:7").unwrap().gid, 7);
        assert_eq!(resolve_in("user:").unwrap().gid, 1000);
    }

    #[test]
    fn unknown_names_are_errors() {
        assert_eq!(
            resolve_in("nobody"),
            Err(UserError::NoSuchUser("nobody".into()))
        );
        assert_eq!(
            resolve_in("user:wheel"),
            Err(UserError::NoSuchGroup("wheel".into()))
        );
        assert!(
            resolve_in("nobody")
                .unwrap_err()
                .to_string()
                .contains("nobody")
        );
    }
}
