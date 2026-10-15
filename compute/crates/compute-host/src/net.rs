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
//! sandbox. A host marked `trusted` also lets guests reach the private and
//! shared ranges, its local network. The rules are enforced twice: inside
//! the namespace, which the VMM joins without the privilege to change it,
//! and again on the host.
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

use crate::protocol::Id;

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
/// (RFC 6598) ranges. Blocked unless the host is trusted.
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
        if prefix > 30 {
            return Err(format!("{text}: prefix must be at most 30"));
        }
        let mask = u32::MAX << (32 - u32::from(prefix));
        if u32::from(address) & !mask != 0 {
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
    /// Lets guests reach the host's local network (the private and shared
    /// ranges). The host itself, metadata services and other sandboxes stay
    /// blocked.
    pub trusted: bool,
    /// More ranges guests may not reach, such as the host's public address
    /// where a cloud maps it onto a private one.
    pub blocked: Vec<Ipv4Net>,
    /// Name servers given to guests on the kernel command line.
    pub dns: Vec<Ipv4Addr>,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            pool: Ipv4Net {
                address: Ipv4Addr::new(198, 18, 0, 0),
                prefix: 15,
            },
            trusted: false,
            blocked: Vec::new(),
            dns: vec![Ipv4Addr::new(1, 1, 1, 1), Ipv4Addr::new(8, 8, 8, 8)],
        }
    }
}

impl NetworkConfig {
    /// The kernel command line arguments that configure the guest's
    /// interface at boot.
    #[must_use]
    pub fn boot_args(&self) -> String {
        let mut args = format!("ip={GUEST_IP}::{GATEWAY_IP}:{LINK_MASK}::eth0:off");
        for server in self.dns.iter().take(2) {
            let _ = write!(args, ":{server}");
        }
        args
    }

    /// Every range guests may not reach.
    fn blocked(&self) -> Vec<String> {
        let mut blocked: Vec<String> = ALWAYS_BLOCKED.iter().map(|&net| net.to_owned()).collect();
        if !self.trusted {
            blocked.extend(LOCAL_NETWORK.iter().map(|&net| net.to_owned()));
        }
        blocked.push(self.pool.to_string());
        blocked.extend(self.blocked.iter().map(ToString::to_string));
        blocked
    }

    /// The host's own rules, replacing any earlier version atomically.
    fn host_rules(&self) -> String {
        let blocked = self.blocked().join(", ");
        let pool = self.pool;
        format!(
            "table inet {HOST_TABLE}
delete table inet {HOST_TABLE}
table inet {HOST_TABLE} {{
    chain input {{
        type filter hook input priority filter - 10; policy accept;
        iifname \"{PREFIX}*\" drop
    }}
    chain forward {{
        type filter hook forward priority filter - 10; policy accept;
        iifname \"{PREFIX}*\" oifname \"{PREFIX}*\" drop
        iifname \"{PREFIX}*\" ip daddr {{ {blocked} }} drop
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
    /// blocked addresses; everything else gets ICMP admin-prohibited.
    fn sandbox_rules(&self, mtu: u32) -> String {
        let blocked = self.blocked().join(", ");
        let mss = mtu.saturating_sub(40);
        format!(
            "table inet {SANDBOX_TABLE}
delete table inet {SANDBOX_TABLE}
table inet {SANDBOX_TABLE} {{
    chain input {{
        type filter hook input priority filter; policy drop;
        iifname \"lo\" accept
        iifname \"{TAP}\" meta l4proto tcp reject with tcp reset
        iifname \"{TAP}\" reject with icmpx type admin-prohibited
    }}
    chain forward {{
        type filter hook forward priority filter; policy drop;
        tcp flags syn / syn,rst tcp option maxseg size > {mss} tcp option maxseg size set {mss}
        ct state {{ established, related }} accept
        iifname \"{TAP}\" oifname \"{UPLINK}\" ip saddr {GUEST_IP} ip daddr != {{ {blocked} }} accept
        iifname \"{TAP}\" meta l4proto tcp reject with tcp reset
        iifname \"{TAP}\" reject with icmpx type admin-prohibited
    }}
    chain output {{
        type filter hook output priority filter; policy drop;
        ct state related accept
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
    /// The network of the sandbox numbered `ordinal`, whose VMM runs as
    /// `uid`/`gid`.
    pub fn new(
        config: &NetworkConfig,
        id: Id,
        ordinal: u32,
        uid: u32,
        gid: u32,
    ) -> Result<Self, PoolFull> {
        let offset = u64::from(ordinal) * 2;
        if offset + 1 >= config.pool.size() {
            return Err(PoolFull);
        }
        let base = u64::from(u32::from(config.pool.address)) + offset;
        let host_ip = Ipv4Addr::from(u32::try_from(base).map_err(|_| PoolFull)?);
        let inner_ip = Ipv4Addr::from(u32::try_from(base + 1).map_err(|_| PoolFull)?);
        Ok(Self {
            namespace: namespace_name(id),
            host: format!("{PREFIX}{ordinal}"),
            host_ip,
            inner_ip,
            uid,
            gid,
        })
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

    /// `ip -batch` lines run on the host.
    fn host_commands(&self, mtu: u32) -> String {
        let Self {
            namespace,
            host,
            host_ip,
            ..
        } = self;
        format!(
            "netns add {namespace}
link add {host} mtu {mtu} type veth peer name {UPLINK} mtu {mtu} netns {namespace}
addr add {host_ip}/31 dev {host}
link set dev {host} up
"
        )
    }

    /// `ip -batch` lines run inside the namespace.
    fn namespace_commands(&self) -> String {
        let Self {
            host_ip,
            inner_ip,
            uid,
            gid,
            ..
        } = self;
        format!(
            "link set dev lo up
addr add {inner_ip}/31 dev {UPLINK}
link set dev {UPLINK} up
route add default via {host_ip} dev {UPLINK}
tuntap add dev {TAP} mode tap user {uid} group {gid}
link set dev {TAP} address {TAP_MAC}
addr add {GATEWAY_IP}/{LINK_PREFIX} dev {TAP}
link set dev {TAP} up
neigh replace {GUEST_IP} lladdr {GUEST_MAC} dev {TAP} nud permanent
"
        )
    }
}

/// The namespace name of sandbox `id`.
fn namespace_name(id: Id) -> String {
    format!("{PREFIX}-{id}")
}

/// The host's sandbox networking. Every method blocks; call them off the
/// async runtime's worker threads.
#[derive(Debug)]
pub(crate) struct Networks {
    /// The MTU of the host's route to the internet.
    mtu: u32,
    sandbox_rules: String,
}

impl Networks {
    /// Turns on forwarding, installs the host's rules and measures the
    /// host's uplink MTU.
    pub fn prepare(config: &NetworkConfig) -> Result<Self, NetError> {
        std::fs::write("/proc/sys/net/ipv4/ip_forward", "1")
            .map_err(|error| NetError::new("enable forwarding", error))?;
        run("nft", &["-f", "-"], Some(&config.host_rules()))?;
        let mtu = uplink_mtu().unwrap_or_else(|error| {
            tracing::warn!(%error, "could not find the host's uplink MTU; assuming 1500");
            1500
        });
        Ok(Self {
            sandbox_rules: config.sandbox_rules(mtu),
            mtu,
        })
    }

    /// Makes sure `link` exists and carries the current rules. A complete
    /// network is left as it is, so a VM using it keeps running; a partial
    /// one, from a crash part way through setting up, is rebuilt.
    pub fn ensure(&self, link: &Link) -> Result<(), NetError> {
        let path = link.namespace_path();
        if path.exists() {
            let complete = in_namespace(&path, || Ok(has_interface(TAP)))?;
            if !complete {
                self.remove(&link.namespace)?;
                self.create(link)?;
            }
        } else {
            self.create(link)?;
        }
        self.configure(link)
    }

    fn create(&self, link: &Link) -> Result<(), NetError> {
        // A host link left by a namespace that is gone would block the name.
        let _ = run("ip", &["link", "del", "dev", &link.host], None);
        run("ip", &["-batch", "-"], Some(&link.host_commands(self.mtu)))?;
        in_namespace(&link.namespace_path(), || {
            run("ip", &["-batch", "-"], Some(&link.namespace_commands()))
        })
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

    /// Deletes sandbox `id`'s network; succeeds when there is none. The
    /// host's end of the link goes with the namespace.
    pub fn remove_for(&self, id: Id) -> Result<(), NetError> {
        self.remove(&namespace_name(id))
    }

    #[allow(clippy::unused_self)]
    fn remove(&self, namespace: &str) -> Result<(), NetError> {
        if !Path::new(NETNS_DIR).join(namespace).exists() {
            return Ok(());
        }
        run("ip", &["netns", "del", namespace], None)
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

/// Whether the calling thread's network namespace has interface `name`.
fn has_interface(name: &str) -> bool {
    std::fs::read_to_string("/proc/thread-self/net/dev").is_ok_and(|devices| {
        devices
            .lines()
            .filter_map(|line| line.split_once(':'))
            .any(|(device, _)| device.trim() == name)
    })
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
mod tests {
    use compute_core::SandboxId;

    use super::*;

    fn id() -> Id {
        Id(SandboxId(0xab))
    }

    #[test]
    fn pools_parse_and_reject_nonsense() {
        let pool: Ipv4Net = "198.18.0.0/15".parse().unwrap();
        assert_eq!(pool.size(), 1 << 17);
        assert_eq!(pool.to_string(), "198.18.0.0/15");
        assert!("198.18.0.1/15".parse::<Ipv4Net>().is_err());
        assert!("198.18.0.0".parse::<Ipv4Net>().is_err());
        assert!("198.18.0.0/31".parse::<Ipv4Net>().is_err());
    }

    #[test]
    fn each_sandbox_gets_its_own_pair_of_link_addresses() {
        let config = NetworkConfig::default();
        let first = Link::new(&config, id(), 0, 1000, 1000).unwrap();
        assert_eq!(first.host, "ogc0");
        assert_eq!(first.host_ip, Ipv4Addr::new(198, 18, 0, 0));
        assert_eq!(first.inner_ip, Ipv4Addr::new(198, 18, 0, 1));
        let later = Link::new(&config, id(), 300, 1300, 1300).unwrap();
        assert_eq!(later.host_ip, Ipv4Addr::new(198, 18, 2, 88));
        assert_eq!(later.inner_ip, Ipv4Addr::new(198, 18, 2, 89));
        let last = Link::new(&config, id(), (1 << 16) - 1, 0, 0).unwrap();
        assert_eq!(last.inner_ip, Ipv4Addr::new(198, 19, 255, 255));
        assert_eq!(Link::new(&config, id(), 1 << 16, 0, 0), Err(PoolFull));
        assert_eq!(
            first.namespace_path(),
            Path::new("/run/netns/ogc-000000000000000000000000000000ab")
        );
        assert!(
            first.host.len() <= 15 && last.host.len() <= 15,
            "interface names fit"
        );
    }

    #[test]
    fn guests_boot_with_the_fixed_address() {
        assert_eq!(
            NetworkConfig::default().boot_args(),
            "ip=169.254.0.21::169.254.0.22:255.255.255.252::eth0:off:1.1.1.1:8.8.8.8"
        );
    }

    #[test]
    fn untrusted_hosts_block_the_local_network_and_trusted_ones_do_not() {
        let untrusted = NetworkConfig::default();
        let trusted = NetworkConfig {
            trusted: true,
            blocked: vec!["93.184.216.0/24".parse().unwrap()],
            ..NetworkConfig::default()
        };
        for config in [&untrusted, &trusted] {
            let blocked = config.blocked();
            for always in [
                "169.254.0.0/16",
                "127.0.0.0/8",
                "198.18.0.0/15",
                "224.0.0.0/4",
            ] {
                assert!(blocked.iter().any(|net| net == always), "{always}");
            }
        }
        for local in LOCAL_NETWORK {
            assert!(untrusted.blocked().iter().any(|net| net == local));
            assert!(!trusted.blocked().iter().any(|net| net == local));
        }
        assert!(trusted.blocked().iter().any(|net| net == "93.184.216.0/24"));
        let rules = untrusted.sandbox_rules(1460);
        assert!(rules.contains("policy drop"));
        assert!(rules.contains("meta l4proto tcp reject with tcp reset"));
        assert!(rules.contains("10.0.0.0/8"));
        assert!(rules.contains("maxseg size set 1420"));
        assert!(rules.contains("oifname \"uplink\" masquerade"));
        let host = untrusted.host_rules();
        assert!(host.contains("iifname \"ogc*\" oifname \"ogc*\" drop"));
        assert!(host.contains("ip saddr 198.18.0.0/15 oifname != \"ogc*\" masquerade"));
    }

    #[test]
    fn setup_names_the_namespace_link_and_tap() {
        let link = Link::new(&NetworkConfig::default(), id(), 2, 1002, 1002).unwrap();
        let host = link.host_commands(1460);
        assert!(
            host.contains("link add ogc2 mtu 1460 type veth peer name uplink mtu 1460 netns ogc-")
        );
        assert!(host.contains("addr add 198.18.0.4/31 dev ogc2"));
        let inner = link.namespace_commands();
        assert!(inner.contains("route add default via 198.18.0.4 dev uplink"));
        assert!(inner.contains("tuntap add dev tap0 mode tap user 1002 group 1002"));
        assert!(inner.contains("neigh replace 169.254.0.21 lladdr 06:00:a9:fe:00:15"));
    }
}
