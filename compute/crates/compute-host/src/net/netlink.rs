//! The one thing the agent asks the kernel's routing netlink directly: who
//! owns a tap. `ip -details` prints it too, but turns the numbers into
//! names through the host's user database first, and inside a sandbox's
//! namespace that can block: on a host whose user database asks a network
//! service, such as Google's OS Login asking the metadata server, which no
//! namespace can reach, each lookup waits out its timeout (15 seconds a tap
//! on a GCE host), and an agent restart re-checks every sandbox's tap.

use std::io;
use std::os::fd::OwnedFd;

use rustix::net::{AddressFamily, RecvFlags, SendFlags, SocketFlags, SocketType};

use super::NetError;

const NLMSG_HEADER: usize = 16;
const NLMSG_ERROR: u16 = 2;
const NLM_F_REQUEST: u16 = 1;
const RTM_NEWLINK: u16 = 16;
const RTM_GETLINK: u16 = 18;
/// `struct ifinfomsg`.
const IFINFO: usize = 16;
const IFLA_IFNAME: u16 = 3;
const IFLA_LINKINFO: u16 = 18;
const IFLA_EXT_MASK: u16 = 29;
const IFLA_INFO_KIND: u16 = 1;
const IFLA_INFO_DATA: u16 = 2;
const IFLA_TUN_OWNER: u16 = 1;
const IFLA_TUN_GROUP: u16 = 2;
/// Leaves the interface's statistics out of the answer.
const RTEXT_FILTER_SKIP_STATS: u32 = 1 << 3;
/// An attribute's type without its nested and byte-order flags.
const NLA_TYPE_MASK: u16 = 0x3fff;
const ENODEV: i32 = 19;

/// The user and group a tun or tap device may be opened by, when it is
/// limited to them: the kernel reports each only when it is set.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Owner {
    pub user: Option<u32>,
    pub group: Option<u32>,
}

/// The owner of interface `name` in the calling thread's network
/// namespace: `None` when it has no such interface, and no owner for an
/// interface that is not a tun or tap device. Asks the kernel once, and
/// nothing else.
pub(super) fn tun_owner(name: &str) -> Result<Option<Owner>, NetError> {
    let command = format!("netlink: get link {name}");
    let failed = |error: io::Error| NetError::new(&command, error);
    // A netlink socket answers for the namespace it was opened in.
    let socket: OwnedFd = rustix::net::socket_with(
        AddressFamily::NETLINK,
        SocketType::RAW,
        SocketFlags::CLOEXEC,
        None,
    )
    .map_err(|error| failed(error.into()))?;
    let request = get_link(name).map_err(|detail| NetError::new(&command, detail))?;
    rustix::net::send(&socket, &request, SendFlags::empty())
        .map_err(|error| failed(error.into()))?;
    let mut reply = vec![0_u8; 64 * 1024];
    let (received, length) = rustix::net::recv(&socket, &mut reply[..], RecvFlags::TRUNC)
        .map_err(|error| failed(error.into()))?;
    if length > received {
        return Err(NetError::new(
            &command,
            format!("answer of {length} bytes is larger than {}", reply.len()),
        ));
    }
    parse_reply(&reply[..received]).map_err(|detail| NetError::new(&command, detail))
}

/// An `RTM_GETLINK` request for interface `name`, without its statistics.
fn get_link(name: &str) -> Result<Vec<u8>, String> {
    if name.is_empty() || name.len() >= 16 || name.contains('\0') {
        return Err(format!("{name:?} is not an interface name"));
    }
    let mut message = vec![0_u8; NLMSG_HEADER + IFINFO];
    message[4..6].copy_from_slice(&RTM_GETLINK.to_ne_bytes());
    message[6..8].copy_from_slice(&NLM_F_REQUEST.to_ne_bytes());
    message[8..12].copy_from_slice(&1_u32.to_ne_bytes());
    // ifinfomsg stays zero: any family, and index 0 so the name decides.
    let mut terminated = name.as_bytes().to_vec();
    terminated.push(0);
    push_attribute(&mut message, IFLA_IFNAME, &terminated);
    push_attribute(
        &mut message,
        IFLA_EXT_MASK,
        &RTEXT_FILTER_SKIP_STATS.to_ne_bytes(),
    );
    let length = u32::try_from(message.len()).map_err(|error| error.to_string())?;
    message[0..4].copy_from_slice(&length.to_ne_bytes());
    Ok(message)
}

fn push_attribute(message: &mut Vec<u8>, kind: u16, value: &[u8]) {
    let length = 4 + value.len();
    message.extend_from_slice(&u16::try_from(length).unwrap_or(u16::MAX).to_ne_bytes());
    message.extend_from_slice(&kind.to_ne_bytes());
    message.extend_from_slice(value);
    message.resize(message.len() + padding(length), 0);
}

fn padding(length: usize) -> usize {
    (4 - length % 4) % 4
}

/// What the kernel answered a [`get_link`].
fn parse_reply(reply: &[u8]) -> Result<Option<Owner>, String> {
    let header = reply
        .get(..NLMSG_HEADER)
        .ok_or_else(|| format!("answer of {} bytes has no header", reply.len()))?;
    let length = usize::try_from(u32_at(header, 0)?).map_err(|error| error.to_string())?;
    let kind = u16_at(header, 4)?;
    let body = reply
        .get(NLMSG_HEADER..length)
        .ok_or_else(|| format!("answer says {length} bytes but has {}", reply.len()))?;
    match kind {
        NLMSG_ERROR => {
            let code = i32::from_ne_bytes(
                body.get(..4)
                    .ok_or("error answer without its code")?
                    .try_into()
                    .map_err(|_| "error answer without its code")?,
            );
            match -code {
                0 => Err("acknowledged without the link".into()),
                ENODEV => Ok(None),
                errno => Err(io::Error::from_raw_os_error(errno).to_string()),
            }
        }
        RTM_NEWLINK => {
            let attributes = body
                .get(IFINFO..)
                .ok_or("link answer without its interface header")?;
            let mut owner = Owner::default();
            if let Some(info) = attribute(attributes, IFLA_LINKINFO)? {
                let is_tun = attribute(info, IFLA_INFO_KIND)?
                    .is_some_and(|kind| kind.split(|byte| *byte == 0).next() == Some(b"tun"));
                if is_tun && let Some(data) = attribute(info, IFLA_INFO_DATA)? {
                    owner.user = attribute(data, IFLA_TUN_OWNER)?
                        .map(|value| u32_at(value, 0))
                        .transpose()?;
                    owner.group = attribute(data, IFLA_TUN_GROUP)?
                        .map(|value| u32_at(value, 0))
                        .transpose()?;
                }
            }
            Ok(Some(owner))
        }
        other => Err(format!("unexpected answer of type {other}")),
    }
}

/// The value of the first attribute of type `wanted` in `attributes`.
fn attribute(mut attributes: &[u8], wanted: u16) -> Result<Option<&[u8]>, String> {
    while attributes.len() >= 4 {
        let length = usize::from(u16_at(attributes, 0)?);
        let kind = u16_at(attributes, 2)? & NLA_TYPE_MASK;
        let value = attributes
            .get(4..length)
            .ok_or_else(|| format!("attribute {kind} of {length} bytes is cut short"))?;
        if kind == wanted {
            return Ok(Some(value));
        }
        attributes = attributes
            .get(length + padding(length)..)
            .unwrap_or_default();
    }
    Ok(None)
}

fn u16_at(bytes: &[u8], at: usize) -> Result<u16, String> {
    bytes
        .get(at..at + 2)
        .and_then(|value| value.try_into().ok())
        .map(u16::from_ne_bytes)
        .ok_or_else(|| format!("no 16-bit value at {at} of {} bytes", bytes.len()))
}

fn u32_at(bytes: &[u8], at: usize) -> Result<u32, String> {
    bytes
        .get(at..at + 4)
        .and_then(|value| value.try_into().ok())
        .map(u32::from_ne_bytes)
        .ok_or_else(|| format!("no 32-bit value at {at} of {} bytes", bytes.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A link answer whose link info holds `kind` and, nested, `data`.
    fn link_answer(info: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut message = vec![0_u8; NLMSG_HEADER + IFINFO];
        message[4..6].copy_from_slice(&RTM_NEWLINK.to_ne_bytes());
        push_attribute(&mut message, IFLA_IFNAME, b"tap0\0");
        let mut nested = Vec::new();
        for (kind, value) in info {
            push_attribute(&mut nested, *kind, value);
        }
        push_attribute(&mut message, IFLA_LINKINFO | 0x8000, &nested);
        let length = u32::try_from(message.len()).unwrap();
        message[0..4].copy_from_slice(&length.to_ne_bytes());
        message
    }

    fn tun_data(attributes: &[(u16, u32)]) -> Vec<u8> {
        let mut data = Vec::new();
        // A one-byte attribute first, so the others need its padding skipped.
        push_attribute(&mut data, 3, &[2]);
        for (kind, value) in attributes {
            push_attribute(&mut data, *kind, &value.to_ne_bytes());
        }
        data
    }

    #[test]
    fn a_taps_owner_is_read_from_its_link_info() {
        let answer = link_answer(&[
            (IFLA_INFO_KIND, b"tun\0".to_vec()),
            (
                IFLA_INFO_DATA | 0x8000,
                tun_data(&[
                    (IFLA_TUN_OWNER, 1_073_741_843),
                    (IFLA_TUN_GROUP, 1_073_741_844),
                ]),
            ),
        ]);
        assert_eq!(
            parse_reply(&answer).unwrap(),
            Some(Owner {
                user: Some(1_073_741_843),
                group: Some(1_073_741_844),
            })
        );

        // The kernel leaves out what is not set.
        let answer = link_answer(&[
            (IFLA_INFO_KIND, b"tun\0".to_vec()),
            (IFLA_INFO_DATA, tun_data(&[(IFLA_TUN_GROUP, 7)])),
        ]);
        assert_eq!(
            parse_reply(&answer).unwrap(),
            Some(Owner {
                user: None,
                group: Some(7),
            })
        );
    }

    #[test]
    fn other_links_have_no_owner_and_a_missing_one_is_none() {
        let veth = link_answer(&[
            (IFLA_INFO_KIND, b"veth\0".to_vec()),
            (IFLA_INFO_DATA, tun_data(&[(IFLA_TUN_OWNER, 5)])),
        ]);
        assert_eq!(parse_reply(&veth).unwrap(), Some(Owner::default()));

        let mut missing = vec![0_u8; NLMSG_HEADER + 4 + NLMSG_HEADER];
        let length = u32::try_from(missing.len()).unwrap();
        missing[0..4].copy_from_slice(&length.to_ne_bytes());
        missing[4..6].copy_from_slice(&NLMSG_ERROR.to_ne_bytes());
        missing[16..20].copy_from_slice(&(-ENODEV).to_ne_bytes());
        assert_eq!(parse_reply(&missing).unwrap(), None);

        missing[16..20].copy_from_slice(&(-1_i32).to_ne_bytes());
        assert!(parse_reply(&missing).is_err(), "other errors are errors");
    }

    #[test]
    fn cut_short_answers_are_errors() {
        let answer = link_answer(&[
            (IFLA_INFO_KIND, b"tun\0".to_vec()),
            (IFLA_INFO_DATA, tun_data(&[(IFLA_TUN_OWNER, 5)])),
        ]);
        for cut in [0, 10, NLMSG_HEADER + 4, answer.len() - 3] {
            let mut short = answer[..cut].to_vec();
            if short.len() >= 4 {
                // Its header claims what is left, so only the cut shows.
                let length = u32::try_from(short.len()).unwrap();
                short[0..4].copy_from_slice(&length.to_ne_bytes());
            }
            assert!(parse_reply(&short).is_err(), "cut at {cut}");
        }
        // A header that claims more than arrived.
        let mut claims_more = answer.clone();
        claims_more.truncate(answer.len() - 8);
        assert!(parse_reply(&claims_more).is_err());
        assert!(get_link("").is_err());
        assert!(get_link("a-name-longer-than-15").is_err());
    }

    /// Asks the kernel itself, in the test's own namespace, without root.
    #[test]
    fn the_kernel_answers_for_loopback_and_for_a_missing_link() {
        assert_eq!(tun_owner("lo").unwrap(), Some(Owner::default()));
        assert_eq!(tun_owner("ogc-no-such0").unwrap(), None);
    }
}
