//! The connections the kernel tracks in a network namespace, and forgetting
//! those the rules installed now would refuse.
//!
//! A firewall decides each connection by its first packet: the kernel lets
//! the rest through, to wherever the first went, for as long as packets
//! keep coming, and a guest that keeps retrying keeps them coming. So when
//! an upgraded agent installs its rules over an older version's under a
//! running guest, a connection the older rules let through, such as queries
//! to a private name server guests may no longer reach, goes on as before:
//! never redirected to the guest's own name server, and still carrying
//! answers back from a destination now refused. Forgetting it makes its
//! next packet a new connection, which the rules installed now decide.
//!
//! Connections are listed and deleted over netlink, as the `conntrack` tool
//! does, so hosts need no such tool. Only IPv4 connections are looked at:
//! guests have no other traffic.

use std::io;
use std::net::Ipv4Addr;
use std::os::fd::OwnedFd;
use std::time::Duration;

use rustix::net::{AddressFamily, RecvFlags, SendFlags, SocketFlags, SocketType};

/// netlink's message types and flags (`linux/netlink.h`).
const NLMSG_ERROR: u16 = 2;
const NLMSG_DONE: u16 = 3;
const NLM_F_REQUEST: u16 = 0x1;
const NLM_F_ACK: u16 = 0x4;
const NLM_F_DUMP: u16 = 0x300;
/// The length of a netlink message's header, and of the netfilter header
/// after it.
const HEADER: usize = 16;
const NFGEN: usize = 4;
/// netfilter's IPv4 family.
const AF_INET: u8 = 2;

/// Connection tracking's messages
/// (`linux/netfilter/nfnetlink_conntrack.h`), its subsystem's number in the
/// high byte.
const CT_NEW: u16 = 1 << 8;
const CT_GET: u16 = CT_NEW | 1;
const CT_DELETE: u16 = CT_NEW | 2;
/// The attributes used here.
const CTA_TUPLE_ORIG: u16 = 1;
const CTA_TUPLE_REPLY: u16 = 2;
const CTA_ID: u16 = 12;
const CTA_ZONE: u16 = 18;
const CTA_TUPLE_IP: u16 = 1;
const CTA_TUPLE_PROTO: u16 = 2;
const CTA_IP_V4_SRC: u16 = 1;
const CTA_IP_V4_DST: u16 = 2;
const CTA_PROTO_NUM: u16 = 1;
const CTA_PROTO_DST_PORT: u16 = 3;
/// An attribute's type without its flags (nested, network byte order).
const TYPE_MASK: u16 = 0x3fff;

/// The largest batch of messages the kernel sends at once, with room to
/// spare: it fills a dump's batches to at most 32 KiB.
const BATCH: usize = 64 * 1024;
/// How long the kernel may take to answer a request.
const PATIENCE: Duration = Duration::from_secs(5);

/// One direction of a tracked connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Direction {
    /// Its IP protocol: 6 for TCP, 17 for UDP, 1 for ICMP.
    pub protocol: u8,
    pub source: Ipv4Addr,
    pub destination: Ipv4Addr,
    /// Its destination port, for a protocol with ports.
    pub port: Option<u16>,
}

/// A tracked connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Connection {
    /// As its first packet went.
    pub original: Direction,
    /// As its answers come back: from where the first packet went, unless
    /// it was redirected.
    pub reply: Direction,
    /// What the kernel finds it by and checks it is: its reply direction
    /// and its zone, as the kernel gave them, and its id.
    ///
    /// The kernel finds a connection by either direction, and refuses to
    /// delete one whose id is not the one given. An id is a hash of where
    /// the kernel keeps the connection and of its original direction, and
    /// the kernel keeps a new connection where an ended one was soon after:
    /// one that ended after it was listed and another with the same first
    /// packet, redirected, can share an id, but never a reply direction.
    /// Found by both, a connection is one the same rules decide alike.
    key: Vec<u8>,
}

#[cfg(test)]
impl Connection {
    /// A connection that went `original` and is answered `reply`, as if
    /// listed.
    pub fn between(original: Direction, reply: Direction) -> Self {
        Self {
            original,
            reply,
            key: Vec::new(),
        }
    }
}

/// Forgets every connection tracked in the calling thread's network
/// namespace that `refused` picks, and returns how many it forgot. One
/// that ends meanwhile is not counted.
///
/// # Errors
///
/// The kernel could not be asked, or refused: its connection tracking may
/// have no netlink interface (`nf_conntrack_netlink`).
pub(super) fn forget(refused: impl Fn(&Connection) -> bool) -> io::Result<usize> {
    let mut netlink = Netlink::open()?;
    let mut forgotten = 0;
    for connection in netlink.list()? {
        if refused(&connection) && netlink.delete(&connection.key)? {
            forgotten += 1;
        }
    }
    Ok(forgotten)
}

/// A netlink socket to the kernel's connection tracking, in the network
/// namespace of the thread that opened it.
struct Netlink {
    socket: OwnedFd,
    /// The last request's sequence number.
    sequence: u32,
    batch: Vec<u8>,
}

impl Netlink {
    fn open() -> io::Result<Self> {
        let socket = rustix::net::socket_with(
            AddressFamily::NETLINK,
            SocketType::RAW,
            SocketFlags::CLOEXEC,
            Some(rustix::net::netlink::NETFILTER),
        )?;
        rustix::net::sockopt::set_socket_timeout(
            &socket,
            rustix::net::sockopt::Timeout::Recv,
            Some(PATIENCE),
        )?;
        Ok(Self {
            socket,
            sequence: 0,
            batch: vec![0; BATCH],
        })
    }

    /// Every IPv4 connection tracked. Deleting while the kernel lists
    /// would disturb its walk, so the list is complete first.
    fn list(&mut self) -> io::Result<Vec<Connection>> {
        let sequence = self.send(CT_GET, NLM_F_DUMP, &[])?;
        let mut connections = Vec::new();
        loop {
            let batch = self.receive()?;
            for message in messages(batch) {
                let message = message?;
                if message.sequence != sequence {
                    continue;
                }
                match message.kind {
                    // A dump that failed part way says so at its end.
                    NLMSG_DONE => {
                        return match error(message.body).unwrap_or(0) {
                            0 => Ok(connections),
                            errno => Err(io::Error::from_raw_os_error(errno)),
                        };
                    }
                    NLMSG_ERROR => match error(message.body)? {
                        0 => {}
                        errno => return Err(io::Error::from_raw_os_error(errno)),
                    },
                    CT_NEW => connections.extend(connection(message.body)),
                    _ => {}
                }
            }
        }
    }

    /// Deletes the connection `key` names. False if it was already gone.
    fn delete(&mut self, key: &[u8]) -> io::Result<bool> {
        let sequence = self.send(CT_DELETE, NLM_F_ACK, key)?;
        self.acknowledged(sequence)
    }

    /// Waits for the kernel's answer to request `sequence`: true if done,
    /// false if what it names does not exist.
    fn acknowledged(&mut self, sequence: u32) -> io::Result<bool> {
        loop {
            let batch = self.receive()?;
            for message in messages(batch) {
                let message = message?;
                if message.sequence == sequence && message.kind == NLMSG_ERROR {
                    return match error(message.body)? {
                        0 => Ok(true),
                        errno => {
                            let error = io::Error::from_raw_os_error(errno);
                            if error.kind() == io::ErrorKind::NotFound {
                                Ok(false)
                            } else {
                                Err(error)
                            }
                        }
                    };
                }
            }
        }
    }

    /// Sends a request of `kind` about IPv4 with `flags` and `attributes`,
    /// and returns its sequence number.
    fn send(&mut self, kind: u16, flags: u16, attributes: &[u8]) -> io::Result<u32> {
        self.sequence = self.sequence.wrapping_add(1);
        let message = request(kind, flags, self.sequence, attributes)?;
        rustix::net::send(&self.socket, &message, SendFlags::empty())?;
        Ok(self.sequence)
    }

    /// The next batch of messages from the kernel.
    fn receive(&mut self) -> io::Result<&[u8]> {
        let (_, length) = rustix::net::recv(&self.socket, &mut self.batch[..], RecvFlags::TRUNC)?;
        self.batch
            .get(..length)
            .ok_or_else(|| io::Error::other(format!("a {length}-byte netlink batch did not fit")))
    }
}

/// A request: netlink's header, netfilter's for IPv4, then `attributes`.
fn request(kind: u16, flags: u16, sequence: u32, attributes: &[u8]) -> io::Result<Vec<u8>> {
    let length = HEADER + NFGEN + attributes.len();
    let mut message = Vec::with_capacity(length);
    let total = u32::try_from(length).map_err(|_| io::Error::other("request too large"))?;
    message.extend_from_slice(&total.to_ne_bytes());
    message.extend_from_slice(&kind.to_ne_bytes());
    message.extend_from_slice(&(NLM_F_REQUEST | flags).to_ne_bytes());
    message.extend_from_slice(&sequence.to_ne_bytes());
    // The sender's port: the kernel fills it in.
    message.extend_from_slice(&0_u32.to_ne_bytes());
    // The family, netfilter's version 0 and resource 0.
    message.extend_from_slice(&[AF_INET, 0, 0, 0]);
    message.extend_from_slice(attributes);
    Ok(message)
}

/// One netlink message.
struct Message<'a> {
    kind: u16,
    sequence: u32,
    body: &'a [u8],
}

/// The messages in `batch`; one that does not fit is an error, and ends
/// them.
fn messages(mut batch: &[u8]) -> impl Iterator<Item = io::Result<Message<'_>>> {
    std::iter::from_fn(move || {
        if batch.is_empty() {
            return None;
        }
        let length = word(batch, 0).and_then(|length| usize::try_from(length).ok());
        let (Some(length), Some(kind), Some(sequence)) = (length, half(batch, 4), word(batch, 8))
        else {
            batch = &[];
            return Some(Err(io::Error::other("a truncated netlink message")));
        };
        if length < HEADER || length > batch.len() {
            batch = &[];
            return Some(Err(io::Error::other(
                "a netlink message of the wrong length",
            )));
        }
        let body = &batch[HEADER..length];
        batch = batch.get(aligned(length)..).unwrap_or_default();
        Some(Ok(Message {
            kind,
            sequence,
            body,
        }))
    })
}

/// The error an error message carries, as a positive `errno`; 0 for an
/// acknowledgement or a dump's end.
fn error(body: &[u8]) -> io::Result<i32> {
    let code = word(body, 0).ok_or_else(|| io::Error::other("a truncated netlink error"))?;
    Ok(i32::from_ne_bytes(code.to_ne_bytes()).saturating_neg())
}

/// The connection a [`CT_NEW`] message's `body` describes, if it is
/// complete. One without an id is left out: nothing could tell it apart
/// from another made in its place.
fn connection(body: &[u8]) -> Option<Connection> {
    let (mut original, mut reply, mut tuple, mut zone, mut id) = (None, None, None, None, None);
    for (kind, value, whole) in attributes(body.get(NFGEN..)?) {
        match kind {
            CTA_TUPLE_ORIG => original = direction(value),
            CTA_TUPLE_REPLY => {
                reply = direction(value);
                tuple = Some(whole);
            }
            CTA_ZONE => zone = Some(whole),
            CTA_ID => id = Some(whole),
            _ => {}
        }
    }
    let mut key = Vec::new();
    for attribute in [tuple?].into_iter().chain(zone).chain([id?]) {
        key.extend_from_slice(attribute);
        key.resize(aligned(key.len()), 0);
    }
    Some(Connection {
        original: original?,
        reply: reply?,
        key,
    })
}

/// The direction a tuple attribute's `value` describes, if it is a
/// complete IPv4 one.
fn direction(value: &[u8]) -> Option<Direction> {
    let (mut source, mut destination, mut protocol, mut port) = (None, None, None, None);
    for (kind, value, _) in attributes(value) {
        for (inner, value, _) in attributes(value) {
            match (kind, inner) {
                (CTA_TUPLE_IP, CTA_IP_V4_SRC) => source = address(value),
                (CTA_TUPLE_IP, CTA_IP_V4_DST) => destination = address(value),
                (CTA_TUPLE_PROTO, CTA_PROTO_NUM) => protocol = value.first().copied(),
                (CTA_TUPLE_PROTO, CTA_PROTO_DST_PORT) => {
                    port = value
                        .get(..2)
                        .map(|port| u16::from_be_bytes([port[0], port[1]]));
                }
                _ => {}
            }
        }
    }
    Some(Direction {
        protocol: protocol?,
        source: source?,
        destination: destination?,
        port,
    })
}

/// The attributes in `bytes`, each as its type, its value and the whole
/// attribute; a malformed one ends them.
fn attributes(mut bytes: &[u8]) -> impl Iterator<Item = (u16, &[u8], &[u8])> {
    std::iter::from_fn(move || {
        let length = usize::from(half(bytes, 0)?);
        let kind = half(bytes, 2)? & TYPE_MASK;
        if length < 4 || length > bytes.len() {
            bytes = &[];
            return None;
        }
        let whole = &bytes[..length];
        bytes = bytes.get(aligned(length)..).unwrap_or_default();
        Some((kind, &whole[4..], whole))
    })
}

fn address(value: &[u8]) -> Option<Ipv4Addr> {
    let octets: [u8; 4] = value.get(..4)?.try_into().ok()?;
    Some(Ipv4Addr::from(octets))
}

/// The native-order `u16` at `at` in `bytes`.
fn half(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_ne_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

/// The native-order `u32` at `at` in `bytes`.
fn word(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_ne_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// `length` rounded up to netlink's 4-byte alignment.
const fn aligned(length: usize) -> usize {
    (length + 3) & !3
}

/// Tracks connections as if their packets had passed, for tests.
#[cfg(test)]
pub(super) mod track {
    use super::*;

    const NLM_F_EXCL: u16 = 0x200;
    const NLM_F_CREATE: u16 = 0x400;
    const NLA_F_NESTED: u16 = 0x8000;
    const CTA_TIMEOUT: u16 = 7;
    const CTA_PROTO_SRC_PORT: u16 = 2;
    const CTA_PROTO_ICMP_ID: u16 = 4;
    const CTA_PROTO_ICMP_TYPE: u16 = 5;
    const CTA_PROTO_ICMP_CODE: u16 = 6;
    const ICMP: u8 = 1;

    /// One direction of a connection to track: ports, or an ICMP echo's
    /// identifier as both.
    #[derive(Clone, Copy, Debug)]
    pub struct Way {
        pub protocol: u8,
        pub source: (Ipv4Addr, u16),
        pub destination: (Ipv4Addr, u16),
    }

    impl Way {
        pub fn reversed(self) -> Self {
            Self {
                source: self.destination,
                destination: self.source,
                ..self
            }
        }
    }

    /// Tracks a connection that went `original` and is answered `reply`,
    /// in the calling thread's network namespace, for a minute.
    pub fn connection(original: Way, reply: Way) -> io::Result<()> {
        let mut attributes = tuple(CTA_TUPLE_ORIG, original, false);
        attributes.extend(tuple(CTA_TUPLE_REPLY, reply, true));
        attributes.extend(attribute(CTA_TIMEOUT, &60_u32.to_be_bytes()));
        let mut netlink = Netlink::open()?;
        let sequence = netlink.send(CT_NEW, NLM_F_CREATE | NLM_F_EXCL | NLM_F_ACK, &attributes)?;
        if netlink.acknowledged(sequence)? {
            Ok(())
        } else {
            Err(io::Error::other("the kernel would not track it"))
        }
    }

    /// Every connection tracked in the calling thread's namespace.
    pub fn list() -> io::Result<Vec<Connection>> {
        Netlink::open()?.list()
    }

    /// Deletes `connection`, as listed, in the calling thread's
    /// namespace: false if it is gone.
    pub fn delete(connection: &Connection) -> io::Result<bool> {
        Netlink::open()?.delete(&connection.key)
    }

    /// A tuple attribute, as the kernel sends one; an ICMP echo's answer
    /// is an echo reply.
    pub fn tuple(kind: u16, way: Way, reply: bool) -> Vec<u8> {
        let mut ip = attribute(CTA_IP_V4_SRC, &way.source.0.octets());
        ip.extend(attribute(CTA_IP_V4_DST, &way.destination.0.octets()));
        let mut protocol = attribute(CTA_PROTO_NUM, &[way.protocol]);
        if way.protocol == ICMP {
            protocol.extend(attribute(CTA_PROTO_ICMP_ID, &way.source.1.to_be_bytes()));
            protocol.extend(attribute(CTA_PROTO_ICMP_TYPE, &[if reply { 0 } else { 8 }]));
            protocol.extend(attribute(CTA_PROTO_ICMP_CODE, &[0]));
        } else {
            protocol.extend(attribute(CTA_PROTO_SRC_PORT, &way.source.1.to_be_bytes()));
            protocol.extend(attribute(
                CTA_PROTO_DST_PORT,
                &way.destination.1.to_be_bytes(),
            ));
        }
        let mut inner = attribute(CTA_TUPLE_IP | NLA_F_NESTED, &ip);
        inner.extend(attribute(CTA_TUPLE_PROTO | NLA_F_NESTED, &protocol));
        attribute(kind | NLA_F_NESTED, &inner)
    }

    /// An attribute of `kind` holding `value`, padded.
    pub fn attribute(kind: u16, value: &[u8]) -> Vec<u8> {
        let length = u16::try_from(4 + value.len()).unwrap();
        let mut bytes = length.to_ne_bytes().to_vec();
        bytes.extend_from_slice(&kind.to_ne_bytes());
        bytes.extend_from_slice(value);
        bytes.resize(aligned(bytes.len()), 0);
        bytes
    }

    /// A batch holding one [`CT_NEW`] message with `attributes`, then a
    /// dump's end, as the kernel sends a list.
    pub fn listing(sequence: u32, attributes: &[u8]) -> Vec<u8> {
        let mut batch = request(CT_NEW, 0, sequence, attributes).unwrap();
        // The end holds only a status, 0 for success.
        let mut end = request(NLMSG_DONE, 0, sequence, &[]).unwrap();
        end.truncate(HEADER);
        end.extend_from_slice(&0_i32.to_ne_bytes());
        let length = u32::try_from(end.len()).unwrap().to_ne_bytes();
        end[..4].copy_from_slice(&length);
        batch.extend(end);
        batch
    }
}

#[cfg(test)]
mod tests {
    use super::track::{Way, attribute, listing, tuple};
    use super::*;

    const UDP: u8 = 17;
    const GUEST: Ipv4Addr = Ipv4Addr::new(169, 254, 0, 21);
    const SERVER: Ipv4Addr = Ipv4Addr::new(100, 100, 100, 100);
    const UPLINK: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 1);

    fn query() -> Way {
        Way {
            protocol: UDP,
            source: (GUEST, 40_000),
            destination: (SERVER, 53),
        }
    }

    #[test]
    fn a_listed_connection_reads_as_the_kernel_wrote_it() {
        let reply = Way {
            destination: (UPLINK, 40_000),
            ..query().reversed()
        };
        let mut attributes = tuple(CTA_TUPLE_ORIG, query(), false);
        attributes.extend(tuple(CTA_TUPLE_REPLY, reply, true));
        // Status, a zone (two bytes, padded), a mark it does not need and
        // an id.
        attributes.extend(attribute(3, &0x188_u32.to_be_bytes()));
        attributes.extend(attribute(CTA_ZONE, &7_u16.to_be_bytes()));
        attributes.extend(attribute(8, &0_u32.to_be_bytes()));
        attributes.extend(attribute(CTA_ID, &0xdead_beef_u32.to_be_bytes()));
        let batch = listing(9, &attributes);
        let read: Vec<Message<'_>> = messages(&batch).map(Result::unwrap).collect();
        assert_eq!(read.len(), 2);
        assert_eq!((read[0].kind, read[0].sequence), (CT_NEW, 9));
        assert_eq!(read[1].kind, NLMSG_DONE);
        assert_eq!(error(read[1].body).unwrap(), 0);
        let found = connection(read[0].body).unwrap();
        assert_eq!(
            found.original,
            Direction {
                protocol: UDP,
                source: GUEST,
                destination: SERVER,
                port: Some(53),
            }
        );
        assert_eq!(
            found.reply,
            Direction {
                protocol: UDP,
                source: SERVER,
                destination: UPLINK,
                port: Some(40_000),
            }
        );
        // It is found again by its reply direction, its zone and its id,
        // exactly as given.
        let mut key = tuple(CTA_TUPLE_REPLY, reply, true);
        key.extend(attribute(CTA_ZONE, &7_u16.to_be_bytes()));
        key.extend(attribute(CTA_ID, &0xdead_beef_u32.to_be_bytes()));
        assert_eq!(found.key, key);
    }

    #[test]
    fn incomplete_or_malformed_messages_are_not_connections() {
        // No reply direction.
        let only = tuple(CTA_TUPLE_ORIG, query(), false);
        let batch = listing(1, &only);
        let first = messages(&batch).next().unwrap().unwrap();
        assert!(connection(first.body).is_none());
        // No id.
        let mut both = tuple(CTA_TUPLE_ORIG, query(), false);
        both.extend(tuple(CTA_TUPLE_REPLY, query().reversed(), true));
        let batch = listing(1, &both);
        let first = messages(&batch).next().unwrap().unwrap();
        assert!(connection(first.body).is_none());
        both.extend(attribute(CTA_ID, &1_u32.to_be_bytes()));
        let batch = listing(1, &both);
        let first = messages(&batch).next().unwrap().unwrap();
        assert!(connection(first.body).is_some());
        // A tuple without its protocol.
        let ip = attribute(CTA_IP_V4_SRC, &GUEST.octets());
        let partial = attribute(CTA_TUPLE_ORIG, &attribute(CTA_TUPLE_IP, &ip));
        assert!(direction(&partial[4..]).is_none());
        // An attribute longer than what holds it ends the attributes.
        let mut long = attribute(CTA_TUPLE_ORIG, &[0; 8]);
        long[0] = 200;
        assert_eq!(attributes(&long).count(), 0);
        // A message longer than its batch is an error, and the last.
        let mut cut = listing(1, &only);
        cut.truncate(HEADER + 2);
        let read: Vec<_> = messages(&cut).collect();
        assert_eq!(read.len(), 1);
        assert!(read[0].is_err());
    }

    #[test]
    fn errors_read_as_positive_errnos() {
        assert_eq!(error(&(-2_i32).to_ne_bytes()).unwrap(), 2);
        assert_eq!(error(&0_i32.to_ne_bytes()).unwrap(), 0);
        assert!(error(&[0, 0]).is_err());
    }
}
