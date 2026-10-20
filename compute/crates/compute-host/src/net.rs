//! Each sandbox's network: its own namespace, a fixed guest address, and
//! firewall rules that let it reach the internet and nothing else.
//!
//! ```text
//! guest eth0 169.254.0.21 ── tap0 169.254.0.22 ┐ namespace ogc-<id>:
//!                                              │ forwards, filters, NATs
//!                  host ogc<n> 198.18.a.b ── uplink 198.18.a.b+1
//!                  └ the host routes and NATs out of its own interfaces
//! ```
//!
//! Every guest has the same address, MAC and gateway, and every tap the
//! same MAC, so a guest restored on any host, from a snapshot taken on any
//! other, finds its network exactly as it left it: its address, route and
//! cached gateway entry are all still right, and its first packet goes out.
//! A sandbox's identity on the host is its namespace's uplink address,
//! which the namespace NATs the guest to. (SPACE, Apache-2.0, also gives
//! every guest one fixed address behind per-namespace NAT; it varies MACs
//! and repairs stale gateway entries after restores, which fixed MACs make
//! unnecessary here.)
//!
//! Guest traffic may go to the internet. It may not reach the host, any
//! private, shared, link-local (so not the cloud metadata service at
//! 169.254.169.254), loopback, multicast or reserved range, or any other
//! sandbox. A host may list exact destinations and TCP ports beyond the
//! internet that guests may open, such as a private Opengeni's API
//! ([`reach`]); nothing else private is reachable. The rules are enforced
//! twice: inside the namespace, which the VMM joins without the privilege
//! to change it, and again on the host.
//!
//! Every guest's name server is its gateway, where the host answers inside
//! the namespace ([`dns`]): names the host lists, with their addresses, and
//! the rest through public name servers, never through the host's own.
//! A query a guest sends to a name server it may not reach, such as a
//! private one an older host named before guests were told their gateway,
//! is answered by that same name server instead of being refused.
//!
//! Setting up a namespace takes two `ip` runs and one `nft` run, a few
//! milliseconds each, when a sandbox is created; when the agent restarts,
//! re-checking it takes one `nft` run. Neither happens on a wake.

use std::fmt::{self, Write as _};
use std::fs::File;
use std::io::{self, Write as _};
use std::net::Ipv4Addr;
use std::os::fd::AsFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::str::FromStr;

use compute_engine::Network;
use serde::{Deserialize, Serialize};

use crate::protocol::Id;

mod dns;
pub mod reach;

use reach::Allowed;
pub use reach::Reach;

/// The guest's address, the same in every sandbox.
pub const GUEST_IP: Ipv4Addr = Ipv4Addr::new(169, 254, 0, 21);
/// The guest's gateway: the tap's address in the sandbox's namespace.
pub const GATEWAY_IP: Ipv4Addr = Ipv4Addr::new(169, 254, 0, 22);
/// The guest link's netmask (a /30 holding the guest and its gateway).
const LINK_MASK: Ipv4Addr = Ipv4Addr::new(255, 255, 255, 252);
const LINK_PREFIX: u8 = 30;
/// The guest's MAC, the same in every sandbox (locally administered).
pub const GUEST_MAC: &str = "06:00:a9:fe:00:15";
/// The tap's MAC, the same in every sandbox, so a restored guest's cached
/// gateway entry is always right.
const TAP_MAC: &str = "06:00:a9:fe:00:16";
/// The tap inside each namespace.
pub const TAP: &str = "tap0";
/// The namespace's end of its link to the host.
const UPLINK: &str = "uplink";
/// Prefix of every host-side link and namespace this module creates.
const PREFIX: &str = "ogc";
/// The host's nftables table.
const HOST_TABLE: &str = "opengeni_compute";
/// Each namespace's nftables table.
const SANDBOX_TABLE: &str = "sandbox";
/// Where `ip netns` keeps named namespaces.
const NETNS_DIR: &str = "/run/netns";

/// Ranges no guest may reach on any host: this network, loopback,
/// link-local (including cloud metadata services), the IETF and
/// documentation ranges, benchmarking (the default link pool), multicast,
/// reserved and broadcast.
const ALWAYS_BLOCKED: &[&str] = &[
    "0.0.0.0/8",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
];

/// The local network: private (RFC 1918) and shared carrier-grade NAT
/// (RFC 6598) ranges, which overlay networks use too. Blocked but for what
/// [`NetworkConfig::reach`] opens.
const LOCAL_NETWORK: &[&str] = &[
    "10.0.0.0/8",
    "100.64.0.0/10",
    "172.16.0.0/12",
    "192.168.0.0/16",
];

/// An IPv4 network such as `198.18.0.0/15`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ipv4Net {
    /// The first address.
    pub address: Ipv4Addr,
    /// The prefix length.
    pub prefix: u8,
}

impl Ipv4Net {
    fn size(self) -> u64 {
        1_u64 << (32 - u32::from(self.prefix))
    }

    /// The network's mask; `/0` has none.
    fn mask(prefix: u8) -> u32 {
        u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0)
    }
}

impl fmt::Display for Ipv4Net {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.address, self.prefix)
    }
}

impl FromStr for Ipv4Net {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let (address, prefix) = text
            .split_once('/')
            .ok_or_else(|| format!("{text} is not address/prefix"))?;
        let address: Ipv4Addr = address
            .parse()
            .map_err(|error| format!("{text}: {error}"))?;
        let prefix: u8 = prefix.parse().map_err(|error| format!("{text}: {error}"))?;
        if prefix > 32 {
            return Err(format!("{text}: prefix must be at most 32"));
        }
        if u32::from(address) & !Self::mask(prefix) != 0 {
            return Err(format!("{text}: host bits are set"));
        }
        Ok(Self { address, prefix })
    }
}

/// How a host networks its sandboxes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkConfig {
    /// Addresses for the links between the host and each sandbox's
    /// namespace, two per sandbox. Must not be used for anything else.
    pub pool: Ipv4Net,
    /// Destinations beyond the internet that guests may open TCP
    /// connections to, with their ports; none may lie in what is always
    /// blocked, the pool or `blocked`.
    pub reach: Vec<Reach>,
    /// More ranges guests may not reach, such as the host's public address
    /// where a cloud maps it onto a private one.
    pub blocked: Vec<Ipv4Net>,
    /// The name servers the host asks for guests, in turn: public ones, so
    /// that guests learn no private name but those `reach` gives.
    pub dns: Vec<Ipv4Addr>,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            pool: Ipv4Net {
                address: Ipv4Addr::new(198, 18, 0, 0),
                prefix: 15,
            },
            reach: Vec::new(),
            blocked: Vec::new(),
            dns: vec![Ipv4Addr::new(1, 1, 1, 1), Ipv4Addr::new(8, 8, 8, 8)],
        }
    }
}

impl NetworkConfig {
    /// Checks the settings that are not checked as they are parsed.
    ///
    /// # Errors
    ///
    /// The pool holds no pair of link addresses.
    pub fn check(&self) -> Result<(), String> {
        if self.pool.prefix > 31 {
            return Err(format!(
                "network pool {} must hold at least two addresses",
                self.pool
            ));
        }
        Ok(())
    }

    /// The link addresses of the sandbox numbered `ordinal`.
    pub(crate) fn addresses(&self, ordinal: u32) -> Result<LinkAddresses, PoolFull> {
        let offset = u64::from(ordinal) * 2;
        if offset + 1 >= self.pool.size() {
            return Err(PoolFull);
        }
        let base = u64::from(u32::from(self.pool.address)) + offset;
        Ok(LinkAddresses {
            host: Ipv4Addr::from(u32::try_from(base).map_err(|_| PoolFull)?),
            inner: Ipv4Addr::from(u32::try_from(base + 1).map_err(|_| PoolFull)?),
        })
    }

    /// The kernel command line arguments that configure the guest's
    /// interface at boot, with its gateway as its name server: the same on
    /// every host.
    #[must_use]
    pub fn boot_args() -> String {
        format!("ip={GUEST_IP}::{GATEWAY_IP}:{LINK_MASK}::eth0:off:{GATEWAY_IP}")
    }

    /// Every range guests may not reach but for what `reach` opens.
    fn blocked(&self) -> Vec<String> {
        let mut blocked: Vec<String> = ALWAYS_BLOCKED.iter().map(|&net| net.to_owned()).collect();
        blocked.extend(LOCAL_NETWORK.iter().map(|&net| net.to_owned()));
        blocked.push(self.pool.to_string());
        blocked.extend(self.blocked.iter().map(ToString::to_string));
        blocked
    }

    /// The ranges `reach` may not open: everything blocked but the local
    /// network.
    fn never(&self) -> Vec<Ipv4Net> {
        let mut never: Vec<Ipv4Net> = ALWAYS_BLOCKED
            .iter()
            .filter_map(|net| net.parse().ok())
            .collect();
        never.push(self.pool);
        never.extend(&self.blocked);
        never
    }

    /// `reach` with every name resolved by the host.
    fn allowed(&self) -> Result<Allowed, NetError> {
        let allowed = Allowed::resolve(&self.reach, &self.never(), look_up)
            .map_err(|error| NetError::new("--reach", error))?;
        if !allowed.open.is_empty() {
            tracing::info!(reach = %allowed.describe(), "sandboxes may also reach");
        }
        Ok(allowed)
    }

    /// The host's own rules, replacing any earlier version atomically.
    fn host_rules(&self, allowed: &Allowed) -> String {
        let blocked = self.blocked().join(", ");
        let reach = allowed.accept_rules(&format!("iifname \"{PREFIX}*\""));
        let pool = self.pool;
        format!(
            "table inet {HOST_TABLE}
delete table inet {HOST_TABLE}
table inet {HOST_TABLE} {{
    chain input {{
        type filter hook input priority filter - 10; policy accept;
        iifname \"{PREFIX}*\" meta l4proto tcp reject with tcp reset
        iifname \"{PREFIX}*\" reject with icmpx type admin-prohibited
    }}
    chain forward {{
        type filter hook forward priority filter - 10; policy accept;
        iifname \"{PREFIX}*\" oifname \"{PREFIX}*\" drop
{reach}        iifname \"{PREFIX}*\" ip daddr {{ {blocked} }} drop
        iifname \"{PREFIX}*\" meta nfproto != ipv4 drop
        oifname \"{PREFIX}*\" ct state != {{ established, related }} drop
    }}
    chain postrouting {{
        type nat hook postrouting priority srcnat; policy accept;
        ip saddr {pool} oifname != \"{PREFIX}*\" masquerade
    }}
}}
"
        )
    }

    /// A sandbox namespace's rules, replacing any earlier version
    /// atomically. TCP segments are clamped both ways to fit the host's
    /// uplink `mtu`, which guests (assuming 1500 bytes) cannot know.
    ///
    /// Refused TCP connections get a reset, which the kernel sends without
    /// any rate limit, so a guest learns at once even when it probes many
    /// blocked addresses; everything else gets ICMP admin-prohibited. The
    /// guest may reach the namespace itself only for its name server.
    ///
    /// A query to port 53 of any address the guest may not reach goes to
    /// its name server instead, which answers as the address would have:
    /// a guest that kept a private name server from an older host, or an
    /// image that names one, still resolves, and learns only what its own
    /// name server tells it. Queries to name servers it may reach, public
    /// ones or a `reach` entry's, go where they were sent.
    fn sandbox_rules(&self, mtu: u32, allowed: &Allowed) -> String {
        let blocked = self.blocked().join(", ");
        let reach = allowed.accept_rules(&format!(
            "iifname \"{TAP}\" oifname \"{UPLINK}\" ip saddr {GUEST_IP}"
        ));
        let reached = allowed.accept_rules(&format!("iifname \"{TAP}\" ip saddr {GUEST_IP}"));
        let dns = dns::PORT;
        let mss = mtu.saturating_sub(40);
        format!(
            "table inet {SANDBOX_TABLE}
delete table inet {SANDBOX_TABLE}
table inet {SANDBOX_TABLE} {{
    chain prerouting {{
        type nat hook prerouting priority dstnat; policy accept;
{reached}        iifname \"{TAP}\" ip saddr {GUEST_IP} ip daddr != {GATEWAY_IP} ip daddr {{ {blocked} }} udp dport {dns} dnat ip to {GATEWAY_IP}
        iifname \"{TAP}\" ip saddr {GUEST_IP} ip daddr != {GATEWAY_IP} ip daddr {{ {blocked} }} tcp dport {dns} dnat ip to {GATEWAY_IP}
    }}
    chain input {{
        type filter hook input priority filter; policy drop;
        iifname \"lo\" accept
        iifname \"{TAP}\" ip saddr {GUEST_IP} ip daddr {GATEWAY_IP} udp dport {dns} accept
        iifname \"{TAP}\" ip saddr {GUEST_IP} ip daddr {GATEWAY_IP} tcp dport {dns} accept
        iifname \"{TAP}\" meta l4proto tcp reject with tcp reset
        iifname \"{TAP}\" reject with icmpx type admin-prohibited
    }}
    chain forward {{
        type filter hook forward priority filter; policy drop;
        tcp flags syn / syn,rst tcp option maxseg size > {mss} tcp option maxseg size set {mss}
        ct state {{ established, related }} accept
{reach}        iifname \"{TAP}\" oifname \"{UPLINK}\" ip saddr {GUEST_IP} ip daddr != {{ {blocked} }} accept
        iifname \"{TAP}\" meta l4proto tcp reject with tcp reset
        iifname \"{TAP}\" reject with icmpx type admin-prohibited
    }}
    chain output {{
        type filter hook output priority filter; policy drop;
        ct state related accept
        oifname \"{TAP}\" ip saddr {GATEWAY_IP} ct state established accept
        oifname \"{TAP}\" tcp flags rst accept
        oifname \"{TAP}\" ip protocol icmp accept
        oifname \"lo\" accept
    }}
    chain postrouting {{
        type nat hook postrouting priority srcnat; policy accept;
        oifname \"{UPLINK}\" masquerade
    }}
}}
"
        )
    }
}

/// Setting up or tearing down a network failed.
#[derive(Debug, thiserror::Error)]
#[error("{command} failed: {detail}")]
pub struct NetError {
    command: String,
    detail: String,
}

impl NetError {
    fn new(command: &str, detail: impl fmt::Display) -> Self {
        Self {
            command: command.to_owned(),
            detail: detail.to_string(),
        }
    }
}

/// The host's link pool has no room for another sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the host's link pool has no room for another sandbox")]
pub struct PoolFull;

/// The two ends of the link between the host and one sandbox's namespace,
/// given to the sandbox when it is created and kept for its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct LinkAddresses {
    /// The host's end.
    pub host: Ipv4Addr,
    /// The namespace's end, which guest traffic leaves the namespace from.
    pub inner: Ipv4Addr,
}

/// One sandbox's network.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Link {
    /// The namespace's name.
    namespace: String,
    /// The host's end of the link.
    host: String,
    host_ip: Ipv4Addr,
    inner_ip: Ipv4Addr,
    /// The VMM's user and group, which own the tap.
    uid: u32,
    gid: u32,
}

impl Link {
    /// The network of sandbox `id`, numbered `ordinal`, at `addresses`,
    /// whose VMM runs as `uid`/`gid`.
    pub fn new(id: Id, ordinal: u32, addresses: LinkAddresses, uid: u32, gid: u32) -> Self {
        Self {
            namespace: namespace_name(id),
            host: host_name(ordinal),
            host_ip: addresses.host,
            inner_ip: addresses.inner,
            uid,
            gid,
        }
    }

    /// The namespace's path, which the VMM joins.
    pub fn namespace_path(&self) -> PathBuf {
        Path::new(NETNS_DIR).join(&self.namespace)
    }

    /// The guest interface for the VM description.
    pub fn vm_network(&self) -> Network {
        Network {
            tap: TAP.to_owned(),
            mac: GUEST_MAC.to_owned(),
            namespace: Some(self.namespace_path()),
        }
    }

    /// `ip -batch` lines run on the host, given which parts exist. Every
    /// line sets a value rather than adding one, so running them again
    /// changes nothing that is right.
    fn host_commands(&self, mtu: u32, namespace_exists: bool, link_exists: bool) -> String {
        let Self {
            namespace,
            host,
            host_ip,
            ..
        } = self;
        let mut commands = String::new();
        if !namespace_exists {
            let _ = writeln!(commands, "netns add {namespace}");
        }
        if !link_exists {
            let _ = writeln!(
                commands,
                "link add {host} mtu {mtu} type veth peer name {UPLINK} mtu {mtu} netns {namespace}"
            );
        }
        let _ = write!(
            commands,
            "addr replace {host_ip}/31 dev {host}
link set dev {host} up
"
        );
        commands
    }

    /// `ip -batch` lines run inside the namespace, given whether its tap
    /// exists. A tap in use by a VM is never replaced, only set right.
    fn namespace_commands(&self, tap: Tap) -> String {
        let Self {
            host_ip,
            inner_ip,
            uid,
            gid,
            ..
        } = self;
        let mut commands = format!(
            "link set dev lo up
addr replace {inner_ip}/31 dev {UPLINK}
link set dev {UPLINK} up
route replace default via {host_ip} dev {UPLINK}
"
        );
        commands.push_str(&tap_commands(tap, *uid, *gid));
        commands
    }
}

/// `ip -batch` lines that give a namespace the guest's side of every
/// sandbox network: the tap, owned by the VMM's `uid` and `gid`, with the
/// gateway's fixed address and the guest's fixed neighbour entry.
fn tap_commands(tap: Tap, uid: u32, gid: u32) -> String {
    let mut commands = String::new();
    if tap == Tap::Foreign {
        let _ = writeln!(commands, "tuntap del dev {TAP} mode tap");
    }
    if tap != Tap::Fits {
        let _ = writeln!(
            commands,
            "tuntap add dev {TAP} mode tap user {uid} group {gid}"
        );
    }
    let _ = write!(
        commands,
        "link set dev {TAP} address {TAP_MAC}
addr replace {GATEWAY_IP}/{LINK_PREFIX} dev {TAP}
link set dev {TAP} up
neigh replace {GUEST_IP} lladdr {GUEST_MAC} dev {TAP} nud permanent
"
    );
    commands
}

/// A network namespace holding only a tap that looks to its guest exactly
/// like a sandbox's, and leads nowhere: for a VM whose saved state must fit
/// every sandbox, such as a template's (see [`crate::pool`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Isolated {
    namespace: String,
}

impl Isolated {
    /// The isolated namespace of the VM named `vm`.
    pub fn new(vm: &str) -> Self {
        Self {
            namespace: format!("{PREFIX}-{vm}"),
        }
    }

    /// The guest interface for the VM description.
    pub fn vm_network(&self) -> Network {
        Network {
            tap: TAP.to_owned(),
            mac: GUEST_MAC.to_owned(),
            namespace: Some(Path::new(NETNS_DIR).join(&self.namespace)),
        }
    }

    /// Creates the namespace, or sets right what an earlier attempt left,
    /// with a tap the VMM running as `uid` and `gid` may open. Blocks.
    pub fn ensure(&self, uid: u32, gid: u32) -> Result<(), NetError> {
        let path = Path::new(NETNS_DIR).join(&self.namespace);
        if !path.exists() {
            run("ip", &["netns", "add", &self.namespace], None)?;
        }
        in_namespace(&path, || {
            let mut commands = "link set dev lo up\n".to_owned();
            commands.push_str(&tap_commands(Tap::find(uid, gid)?, uid, gid));
            run("ip", &["-batch", "-"], Some(&commands))
        })
    }

    /// Deletes the namespace; succeeds when there is none. Blocks.
    pub fn remove(&self) -> Result<(), NetError> {
        if !Path::new(NETNS_DIR).join(&self.namespace).exists() {
            return Ok(());
        }
        run("ip", &["netns", "del", &self.namespace], None)
    }
}

/// The tap a sandbox namespace has, as far as its VM is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tap {
    Missing,
    /// It exists and only the sandbox's own user and group may open it.
    Fits,
    /// It exists but belongs to someone else, as one left behind by an
    /// earlier sandbox with the same id can: the VMM could not open it.
    Foreign,
}

impl Tap {
    /// Looks at the tap of the namespace the calling thread is in.
    fn find(uid: u32, gid: u32) -> Result<Self, NetError> {
        if !has_interface(TAP)? {
            return Ok(Self::Missing);
        }
        let details = output("ip", &["-details", "-oneline", "link", "show", "dev", TAP])?;
        Ok(if tap_owner(&details) == (Some(uid), Some(gid)) {
            Self::Fits
        } else {
            Self::Foreign
        })
    }
}

/// The owner a tap's `ip -details link show` names, from its tun details
/// (`... persist on user U group G ...`); the line also holds an unrelated
/// `group default`.
fn tap_owner(details: &str) -> (Option<u32>, Option<u32>) {
    let words: Vec<&str> = details.split_whitespace().collect();
    let Some(user) = words.iter().position(|word| *word == "user") else {
        return (None, None);
    };
    let number = |at: usize| words.get(at).and_then(|word| word.parse().ok());
    let group = (words.get(user + 2) == Some(&"group"))
        .then(|| number(user + 3))
        .flatten();
    (number(user + 1), group)
}

/// The namespace name of sandbox `id`.
fn namespace_name(id: Id) -> String {
    format!("{PREFIX}-{id}")
}

/// The name of the host's end of the link of the sandbox numbered
/// `ordinal`.
fn host_name(ordinal: u32) -> String {
    format!("{PREFIX}{ordinal}")
}

/// The host's sandbox networking. Every method blocks; call them off the
/// async runtime's worker threads.
#[derive(Debug)]
pub(crate) struct Networks {
    /// The MTU of the host's route to the internet.
    mtu: u32,
    sandbox_rules: String,
    names: dns::NameServer,
}

impl Networks {
    /// Resolves what sandboxes may reach, turns on forwarding, installs
    /// the host's rules and measures the host's uplink MTU. The sandboxes'
    /// name servers run on `runtime`.
    pub fn prepare(
        config: &NetworkConfig,
        runtime: tokio::runtime::Handle,
    ) -> Result<Self, NetError> {
        let allowed = config.allowed()?;
        std::fs::write("/proc/sys/net/ipv4/ip_forward", "1")
            .map_err(|error| NetError::new("enable forwarding", error))?;
        run("nft", &["-f", "-"], Some(&config.host_rules(&allowed)))?;
        warn_of_foreign_forward_drops();
        let mtu = uplink_mtu().unwrap_or_else(|error| {
            tracing::warn!(%error, "could not find the host's uplink MTU; assuming 1500");
            1500
        });
        Ok(Self {
            sandbox_rules: config.sandbox_rules(mtu, &allowed),
            mtu,
            names: dns::NameServer::new(allowed.names, &config.dns, runtime),
        })
    }

    /// Makes sure `link` exists, complete, with the current rules and its
    /// name server: what is missing is added and every setting set,
    /// whatever an earlier attempt cut short left. Nothing that exists is
    /// replaced, so a VM using the network keeps running.
    pub fn ensure(&self, link: &Link) -> Result<(), NetError> {
        let path = link.namespace_path();
        let namespace_exists = path.exists();
        let link_exists = self.clear_stale_link(link, namespace_exists)?;
        let host = link.host_commands(self.mtu, namespace_exists, link_exists);
        run("ip", &["-batch", "-"], Some(&host))?;
        in_namespace(&path, || {
            let inner = link.namespace_commands(Tap::find(link.uid, link.gid)?);
            run("ip", &["-batch", "-"], Some(&inner))
        })?;
        self.configure(link)?;
        self.names.serve(&link.namespace, &path)
    }

    /// Whether `link`'s pair exists whole: its host end and its namespace's
    /// uplink are each other's other end. Otherwise whatever exists of
    /// either is left from something else, such as a namespace another
    /// ordinal's pair still points into, a host end whose namespace is
    /// being taken apart, or a pair one of whose ends was deleted, and is
    /// removed so the pair can be made again. A VM in the namespace keeps
    /// its tap meanwhile; its network was broken anyway.
    /// Nothing is removed unless both ends were looked at: a failed look
    /// fails the call.
    #[allow(clippy::unused_self)]
    fn clear_stale_link(&self, link: &Link, namespace_exists: bool) -> Result<bool, NetError> {
        let path = link.namespace_path();
        let host = veth_ends(&link.host)?;
        let uplink = if namespace_exists {
            in_namespace(&path, || veth_ends(UPLINK))?
        } else {
            None
        };
        if let (Some(host), Some(uplink)) = (host, uplink)
            && host.paired_with(uplink)
        {
            return Ok(true);
        }
        if host.is_some() {
            delete_link(&link.host)?;
        }
        if uplink.is_some() {
            in_namespace(&path, || {
                // Deleting its old peer may have taken it already.
                let deleted = run("ip", &["link", "del", "dev", UPLINK], None);
                if deleted.is_err() && has_interface(UPLINK)? {
                    return deleted;
                }
                Ok(())
            })?;
        }
        Ok(false)
    }

    /// Sets the namespace's kernel settings and rules to the current ones.
    ///
    /// The only host a namespace sends ICMP errors to is its own guest, so
    /// the per-destination ICMP rate limit is off: with it, a guest probing
    /// several blocked addresses at once would see all but the first few
    /// refusals arrive a second late, as timeouts. The namespace-wide cap
    /// (`icmp_msgs_per_sec`) still bounds them.
    fn configure(&self, link: &Link) -> Result<(), NetError> {
        in_namespace(&link.namespace_path(), || {
            for (setting, value) in NAMESPACE_SETTINGS {
                let path = Path::new("/proc/sys/net").join(setting);
                std::fs::write(&path, value)
                    .map_err(|error| NetError::new(&path.display().to_string(), error))?;
            }
            run("nft", &["-f", "-"], Some(&self.sandbox_rules))
        })
    }

    /// Deletes sandbox `id`'s network, numbered `ordinal` if it still holds
    /// one; succeeds when there is none. It returns only once every host
    /// end of a link the sandbox had is gone, so no name is handed to
    /// another sandbox while it still exists, and so does a retry after
    /// any failure part way.
    ///
    /// The namespace's uplink is deleted, which deletes its pair whatever
    /// the host end is called, before the namespace's name: until then a
    /// retry finds the namespace and does it again. Then the end `ordinal`
    /// names, which no other sandbox has while this one holds the ordinal,
    /// is deleted if it is still there. Nothing is left to the kernel's
    /// teardown of the namespace, which runs in the background and never
    /// while a process is still inside it.
    ///
    /// Its name server stops first: its sockets would keep the namespace.
    pub fn remove(&self, id: Id, ordinal: Option<u32>) -> Result<(), NetError> {
        let namespace = namespace_name(id);
        self.names.stop(&namespace);
        let path = Path::new(NETNS_DIR).join(&namespace);
        if path.exists() {
            in_namespace(&path, || delete_link(UPLINK))?;
            if let Err(error) = run("ip", &["netns", "del", &namespace], None)
                && path.exists()
            {
                return Err(error);
            }
        }
        ordinal
            .map(host_name)
            .map_or(Ok(()), |end| delete_link(&end))
    }
}

/// The MTU of the interface the host reaches the internet through.
fn uplink_mtu() -> Result<u32, NetError> {
    let route = output("ip", &["-o", "-4", "route", "get", "1.1.1.1"])?;
    let device = route
        .split_whitespace()
        .skip_while(|word| *word != "dev")
        .nth(1)
        .ok_or_else(|| NetError::new("ip route get", format!("no device in {route:?}")))?;
    let path = format!("/sys/class/net/{device}/mtu");
    std::fs::read_to_string(&path)
        .map_err(|error| NetError::new(&path, error))?
        .trim()
        .parse()
        .map_err(|error| NetError::new(&path, error))
}

/// The IPv4 addresses the host's own resolver gives `name`. As the agent
/// may start while the network it reaches the name over is still coming
/// up, a lookup that fails or finds nothing is tried again for a minute.
fn look_up(name: &str) -> Result<Vec<Ipv4Addr>, String> {
    use std::net::{SocketAddr, ToSocketAddrs as _};

    const TRIES: u32 = 12;
    const EVERY: std::time::Duration = std::time::Duration::from_secs(5);
    let mut tried = 1;
    loop {
        let found = (name, 0).to_socket_addrs().map(|addresses| {
            addresses
                .filter_map(|address| match address {
                    SocketAddr::V4(address) => Some(*address.ip()),
                    SocketAddr::V6(_) => None,
                })
                .collect::<Vec<_>>()
        });
        match found {
            Ok(addresses) if !addresses.is_empty() => return Ok(addresses),
            Ok(_) | Err(_) if tried < TRIES => {
                tracing::warn!(
                    name,
                    tried,
                    "could not resolve a name sandboxes may reach yet"
                );
                std::thread::sleep(EVERY);
                tried += 1;
            }
            Ok(addresses) => return Ok(addresses),
            Err(error) => return Err(format!("could not resolve {name}: {error}")),
        }
    }
}

/// Warns of each chain [`foreign_forward_drops`] finds. Never fails: such
/// a chain may well have a rule that accepts sandbox traffic.
fn warn_of_foreign_forward_drops() {
    const LIST: &str = "nft -j list chains";
    let found = output("nft", &["-j", "list", "chains"]).and_then(|listing| {
        foreign_forward_drops(&listing).map_err(|error| NetError::new(LIST, error))
    });
    match found {
        Ok(chains) => {
            for chain in chains {
                tracing::warn!(
                    %chain,
                    "another firewall drops forwarded traffic by default: sandboxes reach \
                     nothing unless it accepts traffic from and to their links ({PREFIX}*); \
                     see the host requirements in docs/operations.md"
                );
            }
        }
        Err(error) => {
            tracing::warn!(%error, "could not look for firewalls that drop sandbox traffic");
        }
    }
}

/// Other tables' chains on the forward hook whose policy drops, named as
/// `nft` names them, from `listing`, the output of `nft -j list chains`.
/// A packet passes a hook only if every base chain on it accepts it, so
/// such a chain drops sandbox traffic unless one of its own rules accepts
/// it: Docker's `FORWARD` chain, for one, drops by default and accepts
/// only its own bridges' traffic. Only IPv4 chains count, the only
/// traffic guests have.
fn foreign_forward_drops(listing: &str) -> Result<Vec<String>, serde_json::Error> {
    let listing: serde_json::Value = serde_json::from_str(listing)?;
    let entries = listing["nftables"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    Ok(entries
        .iter()
        .filter_map(|entry| entry.get("chain"))
        .filter(|chain| {
            let family = chain["family"].as_str().unwrap_or_default();
            matches!(family, "ip" | "inet")
                && chain["hook"] == "forward"
                && chain["policy"] == "drop"
                && !(family == "inet" && chain["table"] == HOST_TABLE)
        })
        .map(|chain| {
            let text = |key: &str| chain[key].as_str().unwrap_or_default().to_owned();
            format!(
                "table {} {} chain {}",
                text("family"),
                text("table"),
                text("name")
            )
        })
        .collect())
}

/// Kernel settings of every sandbox namespace, under `/proc/sys/net`.
const NAMESPACE_SETTINGS: [(&str, &str); 4] = [
    ("ipv4/ip_forward", "1"),
    ("ipv4/icmp_ratelimit", "0"),
    ("ipv6/conf/all/disable_ipv6", "1"),
    ("ipv6/conf/default/disable_ipv6", "1"),
];

/// Runs `work` on a new thread that has joined the network namespace at
/// `path`. Programs it starts inherit the namespace and `/proc/sys/net`
/// shows the namespace's settings. The thread ends with `work`, so nothing
/// else ever runs in the namespace by mistake. This is what `ip netns exec`
/// does, without its new mount namespace and remounted `/sys`, which cost
/// milliseconds each and serialize on kernel locks.
fn in_namespace<T: Send>(
    path: &Path,
    work: impl FnOnce() -> Result<T, NetError> + Send,
) -> Result<T, NetError> {
    use rustix::thread::{LinkNameSpaceType, move_into_link_name_space};

    let namespace = File::open(path).map_err(|error| NetError::new("open namespace", error))?;
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                move_into_link_name_space(namespace.as_fd(), Some(LinkNameSpaceType::Network))
                    .map_err(|error| NetError::new("join namespace", io::Error::from(error)))?;
                work()
            })
            .join()
            .unwrap_or_else(|_| Err(NetError::new("namespace thread", "panicked")))
    })
}

/// An interface in the calling thread's namespace, as one end of a veth
/// pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Veth {
    index: u32,
    /// The index of its other end in the other end's namespace, if it has
    /// one there.
    peer: Option<u32>,
}

impl Veth {
    /// Whether `self` and `other`, in another namespace, are one pair.
    fn paired_with(self, other: Self) -> bool {
        self.peer == Some(other.index) && other.peer == Some(self.index)
    }
}

/// Interface `name` of the calling thread's namespace, or `None` if it
/// proved to be missing. Failing to look is an error, never `None`.
fn veth_ends(name: &str) -> Result<Option<Veth>, NetError> {
    /// The fields of `ip -j link show` used here. `link_index` is present
    /// only when the other end is in another namespace.
    #[derive(Deserialize)]
    struct Shown {
        ifindex: u32,
        link_index: Option<u32>,
    }
    let command = format!("ip -j link show dev {name}");
    crate::layout::failpoint(Path::new(name), "inspect")
        .map_err(|error| NetError::new(&command, error))?;
    if !has_interface(name)? {
        return Ok(None);
    }
    let shown = match output("ip", &["-j", "link", "show", "dev", name]) {
        Ok(shown) => shown,
        // It went while it was looked at.
        Err(_) if !has_interface(name)? => return Ok(None),
        Err(error) => return Err(error),
    };
    let [shown]: [Shown; 1] =
        serde_json::from_str(&shown).map_err(|error| NetError::new(&command, error))?;
    Ok(Some(Veth {
        index: shown.ifindex,
        peer: shown.link_index,
    }))
}

/// Deletes interface `name` of the calling thread's namespace, if it
/// exists, and waits until it is gone. Deleting either end of a veth pair
/// deletes both. It may be going away with its namespace right now, so it
/// can vanish before it is deleted.
fn delete_link(name: &str) -> Result<(), NetError> {
    if !has_interface(name)? {
        return Ok(());
    }
    let deleted = crate::layout::failpoint(Path::new(name), "delete")
        .map_err(|error| NetError::new("ip link del", error))
        .and_then(|()| run("ip", &["link", "del", "dev", name], None));
    if let Err(gone) = wait_gone(name) {
        return Err(deleted.err().unwrap_or(gone));
    }
    Ok(())
}

/// Waits until the host has no interface `name`, as after its namespace
/// was deleted: the kernel destroys a namespace's devices asynchronously.
fn wait_gone(name: &str) -> Result<(), NetError> {
    const LIMIT: std::time::Duration = std::time::Duration::from_secs(10);
    let started = std::time::Instant::now();
    while has_interface(name)? {
        if started.elapsed() > LIMIT {
            return Err(NetError::new(
                &format!("wait for {name} to go"),
                format!("still present after {LIMIT:?}"),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    Ok(())
}

/// Whether the calling thread's network namespace has interface `name`.
fn has_interface(name: &str) -> Result<bool, NetError> {
    const DEVICES: &str = "/proc/thread-self/net/dev";
    let devices =
        std::fs::read_to_string(DEVICES).map_err(|error| NetError::new(DEVICES, error))?;
    Ok(devices
        .lines()
        .filter_map(|line| line.split_once(':'))
        .any(|(device, _)| device.trim() == name))
}

/// Runs `program` with `args`, feeding it `input`, and fails with its
/// error output unless it succeeds.
fn run(program: &str, args: &[&str], input: Option<&str>) -> Result<(), NetError> {
    execute(program, args, input).map(drop)
}

/// Runs `program` with `args` and returns its output.
fn output(program: &str, args: &[&str]) -> Result<String, NetError> {
    execute(program, args, None)
}

fn execute(program: &str, args: &[&str], input: Option<&str>) -> Result<String, NetError> {
    let command = format!("{program} {}", args.join(" "));
    let mut child = Command::new(program)
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| NetError::new(&command, error))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin
            .write_all(input.as_bytes())
            .map_err(|error| NetError::new(&command, error))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| NetError::new(&command, error))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(NetError::new(
            &command,
            format!("{}: {}", output.status, stderr.trim()),
        ))
    }
}

impl From<NetError> for io::Error {
    fn from(error: NetError) -> Self {
        io::Error::other(error)
    }
}

#[cfg(test)]
mod tests;
