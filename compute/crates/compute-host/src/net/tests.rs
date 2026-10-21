use std::sync::{Mutex, MutexGuard, PoisonError};

use compute_core::SandboxId;

use super::*;
use crate::layout::tests::FAILPOINTS;

/// Held by each test that changes the host's networking, which share
/// failpoints on interface names.
static LAB: Mutex<()> = Mutex::new(());

/// Where the lab's name servers run.
static RUNTIME: std::sync::LazyLock<tokio::runtime::Runtime> =
    std::sync::LazyLock::new(|| tokio::runtime::Runtime::new().unwrap());

/// The lab and its prepared networking, or `None` without root and
/// `COMPUTE_TEST_LAB`: a skip, or a failure where
/// `COMPUTE_TEST_REQUIRE` lists `lab`, as on a gate.
fn lab() -> Option<(MutexGuard<'static, ()>, NetworkConfig, Networks)> {
    if std::env::var_os("COMPUTE_TEST_LAB").is_none() || !rustix::process::geteuid().is_root() {
        let required = std::env::var("COMPUTE_TEST_REQUIRE").unwrap_or_default();
        assert!(
            !required.split(',').any(|listed| listed.trim() == "lab"),
            "a required test cannot run: it needs root and COMPUTE_TEST_LAB"
        );
        eprintln!("skipped: needs root and COMPUTE_TEST_LAB");
        return None;
    }
    let guard = LAB.lock().unwrap_or_else(PoisonError::into_inner);
    let config = NetworkConfig::default();
    let networks = Networks::prepare(&config, RUNTIME.handle().clone()).unwrap();
    Some((guard, config, networks))
}

fn fail_at(name: &str, point: &'static str) {
    FAILPOINTS
        .lock()
        .unwrap()
        .push((PathBuf::from(name), point));
}

fn heal(name: &str) {
    FAILPOINTS
        .lock()
        .unwrap()
        .retain(|(path, _)| path != Path::new(name));
}

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
    assert!("198.18.0.0/33".parse::<Ipv4Net>().is_err());
    // Single hosts and everything are valid ranges to block.
    let everything: Ipv4Net = "0.0.0.0/0".parse().unwrap();
    assert_eq!(everything.size(), 1 << 32);
    assert!("1.0.0.0/0".parse::<Ipv4Net>().is_err());
    let host: Ipv4Net = "203.0.113.7/32".parse().unwrap();
    assert_eq!(host.size(), 1);
    let pair: Ipv4Net = "203.0.113.6/31".parse().unwrap();
    assert!("203.0.113.7/31".parse::<Ipv4Net>().is_err());
    // A pool needs room for one sandbox's pair.
    let pool_of = |pool| NetworkConfig {
        pool,
        ..NetworkConfig::default()
    };
    assert!(pool_of(host).check().is_err());
    pool_of(pair).check().unwrap();
    assert!(pool_of(pair).addresses(0).is_ok());
    assert_eq!(pool_of(pair).addresses(1), Err(PoolFull));
}

#[test]
fn each_sandbox_gets_its_own_pair_of_link_addresses() {
    let config = NetworkConfig::default();
    let link = |ordinal| Link::new(id(), ordinal, config.addresses(ordinal).unwrap(), 7, 7);
    let first = link(0);
    assert_eq!(first.host, "ogc0");
    assert_eq!(first.host_ip, Ipv4Addr::new(198, 18, 0, 0));
    assert_eq!(first.inner_ip, Ipv4Addr::new(198, 18, 0, 1));
    let later = link(300);
    assert_eq!(later.host_ip, Ipv4Addr::new(198, 18, 2, 88));
    assert_eq!(later.inner_ip, Ipv4Addr::new(198, 18, 2, 89));
    let last = link((1 << 16) - 1);
    assert_eq!(last.inner_ip, Ipv4Addr::new(198, 19, 255, 255));
    assert_eq!(config.addresses(1 << 16), Err(PoolFull));
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
        NetworkConfig::boot_args(),
        "ip=169.254.0.21::169.254.0.22:255.255.255.252::eth0:off:169.254.0.22"
    );
}

#[test]
fn other_firewalls_that_drop_forwarded_traffic_are_found() {
    // Docker's chains as `nft -j list chains` lists them, with
    // firewalld's, an input chain and the agent's own.
    let listing = r#"{"nftables": [
        {"metainfo": {"version": "1.0.9", "json_schema_version": 1}},
        {"chain": {"family": "ip", "table": "filter", "name": "FORWARD", "handle": 2,
            "type": "filter", "hook": "forward", "prio": 0, "policy": "drop"}},
        {"chain": {"family": "ip", "table": "filter", "name": "DOCKER-USER", "handle": 9}},
        {"chain": {"family": "ip6", "table": "filter", "name": "FORWARD", "handle": 2,
            "type": "filter", "hook": "forward", "prio": 0, "policy": "drop"}},
        {"chain": {"family": "ip", "table": "filter", "name": "INPUT", "handle": 1,
            "type": "filter", "hook": "input", "prio": 0, "policy": "drop"}},
        {"chain": {"family": "inet", "table": "firewalld", "name": "filter_FORWARD",
            "handle": 4, "type": "filter", "hook": "forward", "prio": 10,
            "policy": "accept"}},
        {"chain": {"family": "inet", "table": "opengeni_compute", "name": "forward",
            "handle": 3, "type": "filter", "hook": "forward", "prio": -10,
            "policy": "accept"}}
    ]}"#;
    assert_eq!(
        foreign_forward_drops(listing).unwrap(),
        ["table ip filter chain FORWARD"]
    );
    let only_ours = r#"{"nftables": [{"chain": {"family": "inet",
        "table": "opengeni_compute", "name": "forward", "type": "filter",
        "hook": "forward", "prio": -10, "policy": "accept"}}]}"#;
    let none: [&str; 0] = [];
    assert_eq!(foreign_forward_drops(only_ours).unwrap(), none);
    assert_eq!(foreign_forward_drops(r#"{"nftables": []}"#).unwrap(), none);
    assert!(foreign_forward_drops("not json").is_err());
}

#[test]
fn the_local_network_is_blocked_but_for_the_ports_a_host_lists() {
    let plain = NetworkConfig::default();
    let reaching = NetworkConfig {
        reach: vec!["10.20.0.7:443,9443-9445".parse().unwrap()],
        blocked: vec!["93.184.216.0/24".parse().unwrap()],
        ..NetworkConfig::default()
    };
    for config in [&plain, &reaching] {
        let blocked = config.blocked();
        for always in [
            "169.254.0.0/16",
            "127.0.0.0/8",
            "198.18.0.0/15",
            "224.0.0.0/4",
        ] {
            assert!(blocked.iter().any(|net| net == always), "{always}");
        }
        for local in LOCAL_NETWORK {
            assert!(blocked.iter().any(|net| net == local), "{local}");
        }
    }
    assert!(
        reaching
            .blocked()
            .iter()
            .any(|net| net == "93.184.216.0/24")
    );
    let none = plain.allowed().unwrap();
    let rules = plain.sandbox_rules(1460, &none);
    assert!(rules.contains("policy drop"));
    assert!(rules.contains("meta l4proto tcp reject with tcp reset"));
    assert!(rules.contains("10.0.0.0/8"));
    assert!(rules.contains("maxseg size set 1420"));
    assert!(rules.contains("oifname \"uplink\" masquerade"));
    assert!(!rules.contains("tcp dport {"), "nothing private is open");
    // The guest reaches its namespace only for its name server, which
    // answers it.
    assert!(rules.contains(
        "iifname \"tap0\" ip saddr 169.254.0.21 ip daddr 169.254.0.22 udp dport 53 accept"
    ));
    assert!(rules.contains(
        "iifname \"tap0\" ip saddr 169.254.0.21 ip daddr 169.254.0.22 tcp dport 53 accept"
    ));
    assert!(rules.contains("oifname \"tap0\" ip saddr 169.254.0.22 ct state established accept"));
    // A query to a name server the guest may not reach, such as a private
    // one an older host named, goes to its own name server instead; one to
    // a name server it may reach goes where it was sent.
    for proto in ["udp", "tcp"] {
        let redirect = rules
            .lines()
            .find(|line| line.ends_with(&format!("{proto} dport 53 dnat ip to 169.254.0.22")))
            .unwrap_or_else(|| panic!("{proto} queries are not redirected: {rules}"));
        assert!(redirect.contains(
            "iifname \"tap0\" ip saddr 169.254.0.21 ip daddr != 169.254.0.22 ip daddr { "
        ));
        for closed in [
            "100.64.0.0/10",
            "10.0.0.0/8",
            "169.254.0.0/16",
            "198.18.0.0/15",
        ] {
            assert!(redirect.contains(closed), "{closed}: {redirect}");
        }
    }
    assert!(rules.contains("type nat hook prerouting priority dstnat; policy accept;"));
    let host = plain.host_rules(&none);
    assert!(host.contains("iifname \"ogc*\" oifname \"ogc*\" drop"));
    // The host refuses its sandboxes at once rather than letting their
    // connections time out.
    assert!(host.contains("iifname \"ogc*\" meta l4proto tcp reject with tcp reset"));
    assert!(host.contains("ip saddr 198.18.0.0/15 oifname != \"ogc*\" masquerade"));
    assert!(!host.contains("tcp dport {"));

    // Listed ports open on that address alone, in both firewalls, ahead
    // of what blocks the rest of the local network.
    let allowed = reaching.allowed().unwrap();
    let rules = reaching.sandbox_rules(1460, &allowed);
    let open = "iifname \"tap0\" oifname \"uplink\" ip saddr 169.254.0.21 ip daddr \
                10.20.0.7/32 tcp dport { 443, 9443-9445 } accept";
    let opened = rules
        .find(open)
        .expect("the sandbox opens the listed ports");
    assert!(opened < rules.find("ip daddr != {").unwrap());
    // Listed destinations pass the redirect untouched, ahead of it, so one
    // that lists port 53 keeps its queries.
    let kept = "iifname \"tap0\" ip saddr 169.254.0.21 ip daddr 10.20.0.7/32 tcp dport \
                { 443, 9443-9445 } accept";
    let kept = rules
        .find(kept)
        .expect("listed destinations keep their queries");
    assert!(kept < rules.find("dnat ip to").unwrap());
    assert!(rules.find("chain prerouting").unwrap() < kept);
    assert!(kept < rules.find("chain input").unwrap());
    let host = reaching.host_rules(&allowed);
    let open = "iifname \"ogc*\" ip daddr 10.20.0.7/32 tcp dport { 443, 9443-9445 } accept";
    let opened = host.find(open).expect("the host opens the listed ports");
    assert!(opened > host.find("oifname \"ogc*\" drop").unwrap());
    assert!(opened < host.find("ip daddr {").unwrap());

    // Nothing always blocked, in the pool or listed as blocked opens.
    for closed in ["169.254.169.254:80", "198.18.0.9:22", "93.184.216.34:443"] {
        let config = NetworkConfig {
            reach: vec![closed.parse().unwrap()],
            ..reaching.clone()
        };
        assert!(config.allowed().is_err(), "{closed}");
    }
}

/// A host whose sandboxes may reach port 443 and ports 9443 to 9445 of one
/// local address, and never one public range.
fn reaching() -> NetworkConfig {
    NetworkConfig {
        reach: vec!["10.20.0.7:443,9443-9445".parse().unwrap()],
        blocked: vec!["93.184.216.0/24".parse().unwrap()],
        ..NetworkConfig::default()
    }
}

const TCP: u8 = 6;
const UDP: u8 = 17;
const ICMP: u8 = 1;
/// A sandbox namespace's end of its link, which its traffic leaves from.
const UPLINK_IP: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 1);

fn ip(text: &str) -> Ipv4Addr {
    text.parse().unwrap()
}

/// A connection a guest may have made, (protocol, destination, port, who
/// answers), and whether the rules installed now refuse it.
type Made = ((u8, &'static str, Option<u16>, &'static str), bool);

/// The connections a guest may have made.
fn guest_connections() -> Vec<Made> {
    vec![
        // Queries to a private name server, as an older host named: still
        // going there, refused; redirected, answered by the gateway, kept.
        ((UDP, "100.100.100.100", Some(53), "100.100.100.100"), true),
        ((UDP, "100.100.100.100", Some(53), "169.254.0.22"), false),
        ((TCP, "10.0.0.2", Some(53), "169.254.0.22"), false),
        // The guest's own name server.
        ((UDP, "169.254.0.22", Some(53), "169.254.0.22"), false),
        // The internet, but for a range the host blocks.
        ((TCP, "1.1.1.1", Some(443), "1.1.1.1"), false),
        ((UDP, "8.8.8.8", Some(53), "8.8.8.8"), false),
        ((TCP, "93.184.216.34", Some(443), "93.184.216.34"), true),
        // What `--reach` opens: TCP to the listed ports only.
        ((TCP, "10.20.0.7", Some(443), "10.20.0.7"), false),
        ((TCP, "10.20.0.7", Some(9444), "10.20.0.7"), false),
        ((TCP, "10.20.0.7", Some(22), "10.20.0.7"), true),
        ((UDP, "10.20.0.7", Some(443), "10.20.0.7"), true),
        // The rest of the local network, an overlay's, metadata, the pool.
        ((TCP, "10.20.0.8", Some(443), "10.20.0.8"), true),
        ((ICMP, "100.84.1.1", None, "100.84.1.1"), true),
        ((TCP, "169.254.169.254", Some(80), "169.254.169.254"), true),
        ((TCP, "198.18.0.9", Some(22), "198.18.0.9"), true),
    ]
}

#[test]
fn the_connections_forgotten_are_those_the_rules_refuse() {
    let config = reaching();
    assert_eq!(
        config.blocked_nets().len(),
        config.blocked().len(),
        "every blocked range is a range"
    );
    let refusals = config.refusals(&config.allowed().unwrap());
    let direction = |protocol, source, destination, port| conntrack::Direction {
        protocol,
        source,
        destination,
        port,
    };
    for ((protocol, destination, port, answerer), refused) in guest_connections() {
        let destination = ip(destination);
        let original = direction(protocol, GUEST_IP, destination, port);
        let answered = direction(protocol, ip(answerer), UPLINK_IP, Some(40_000));
        let connection = conntrack::Connection::between(original, answered);
        assert_eq!(
            refusals.in_namespace(&connection),
            refused,
            "in the namespace: {original:?} answered by {answerer}"
        );
        // The host sees it leave the namespace from its uplink; a
        // redirected one never leaves.
        if answerer != GATEWAY_IP.to_string() {
            let left = direction(protocol, UPLINK_IP, destination, port);
            let connection = conntrack::Connection::between(left, answered);
            assert_eq!(
                refusals.on_host(&connection),
                refused,
                "on the host: {left:?}"
            );
        }
    }
    // The namespace's own connections, as its name server's to the
    // upstreams, are not the guest's; the host's own are not a sandbox's.
    let own = direction(UDP, UPLINK_IP, ip("10.0.0.2"), Some(53));
    let answer = direction(UDP, ip("10.0.0.2"), UPLINK_IP, Some(40_000));
    assert!(!refusals.in_namespace(&conntrack::Connection::between(own, answer)));
    let host = direction(TCP, ip("10.0.0.5"), ip("10.0.0.1"), Some(22));
    let answer = direction(TCP, ip("10.0.0.1"), ip("10.0.0.5"), Some(40_000));
    assert!(!refusals.on_host(&conntrack::Connection::between(host, answer)));
}

/// Runs `work` on a thread in a network namespace of its own, so it may
/// change what the kernel tracks there, or skips without root (as in a
/// user namespace of one's own: `unshare -r`), failing instead where
/// `COMPUTE_TEST_REQUIRE` lists `lab`.
fn in_new_namespace(work: impl FnOnce() + Send) {
    if !rustix::process::geteuid().is_root() {
        let required = std::env::var("COMPUTE_TEST_REQUIRE").unwrap_or_default();
        assert!(
            !required.split(',').any(|listed| listed.trim() == "lab"),
            "a required test cannot run: it needs root"
        );
        eprintln!("skipped: needs root");
        return;
    }
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                // SAFETY: only the network namespace is unshared, which
                // no file descriptor depends on.
                unsafe { rustix::thread::unshare_unsafe(rustix::thread::UnshareFlags::NEWNET) }
                    .unwrap();
                work();
            })
            .join()
            .unwrap();
    });
}

/// The kernel lists, keeps and forgets connections as the rules say: those
/// refused go, one by one, by whichever protocol; the rest stay; a second
/// pass finds nothing more to forget.
#[test]
fn the_kernel_forgets_exactly_the_connections_the_rules_refuse() {
    use conntrack::track::{self, Way};

    let config = reaching();
    let refusals = config.refusals(&config.allowed().unwrap());
    let check = |source: Ipv4Addr, on_host: bool| {
        let mut expected = Vec::new();
        for (n, ((protocol, destination, port, answerer), refused)) in
            guest_connections().into_iter().enumerate()
        {
            let answerer = ip(answerer);
            if on_host && answerer == GATEWAY_IP {
                continue;
            }
            let sport = 40_000 + u16::try_from(n).unwrap();
            // An ICMP echo is told apart by its identifier, its "port".
            let original = Way {
                protocol,
                source: (source, sport),
                destination: (ip(destination), port.unwrap_or(sport)),
            };
            let answer = Way {
                protocol,
                source: (answerer, port.unwrap_or(sport)),
                destination: (if on_host { source } else { UPLINK_IP }, sport),
            };
            track::connection(original, answer).unwrap();
            expected.push((ip(destination), protocol, answerer, refused));
        }
        let listed = track::list().unwrap();
        assert_eq!(listed.len(), expected.len(), "all tracked: {listed:?}");
        let refused = expected.iter().filter(|(.., refused)| *refused).count();
        let pick = |connection: &conntrack::Connection| {
            if on_host {
                refusals.on_host(connection)
            } else {
                refusals.in_namespace(connection)
            }
        };
        assert_eq!(conntrack::forget(pick).unwrap(), refused);
        let mut kept: Vec<_> = track::list()
            .unwrap()
            .into_iter()
            .map(|connection| {
                (
                    connection.original.destination,
                    connection.original.protocol,
                    connection.reply.source,
                )
            })
            .collect();
        kept.sort_unstable();
        let mut wanted: Vec<_> = expected
            .iter()
            .filter(|(.., refused)| !refused)
            .map(|&(destination, protocol, answerer, _)| (destination, protocol, answerer))
            .collect();
        wanted.sort_unstable();
        assert_eq!(kept, wanted);
        assert_eq!(conntrack::forget(pick).unwrap(), 0, "nothing more");
    };
    in_new_namespace(|| check(GUEST_IP, false));
    in_new_namespace(|| check(UPLINK_IP, true));
}

/// A connection is listed and ends, and another with the same first
/// packet is tracked in its place, redirected to the guest's own name
/// server, before the listed one is forgotten: the new one stays.
#[test]
fn a_connection_made_in_place_of_one_listed_is_kept() {
    use conntrack::track::{self, Way};

    in_new_namespace(|| {
        let query = Way {
            protocol: 17,
            source: (GUEST_IP, 40_000),
            destination: (ip("100.100.100.100"), 53),
        };
        let answered_privately = Way {
            destination: (UPLINK_IP, 40_000),
            ..query.reversed()
        };
        track::connection(query, answered_privately).unwrap();
        let listed = track::list().unwrap();
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert!(track::delete(&listed[0]).unwrap(), "it ends");
        let redirected = Way {
            source: (GATEWAY_IP, 53),
            ..query.reversed()
        };
        track::connection(query, redirected).unwrap();
        assert!(
            !track::delete(&listed[0]).unwrap(),
            "what was listed is gone"
        );
        let kept = track::list().unwrap();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(kept[0].reply.source, GATEWAY_IP);
    });
}

#[test]
fn setup_names_the_namespace_link_and_tap() {
    let addresses = NetworkConfig::default().addresses(2).unwrap();
    let link = Link::new(id(), 2, addresses, 1002, 1002);
    let host = link.host_commands(1460, false, false);
    assert!(host.contains("netns add ogc-"));
    assert!(host.contains("link add ogc2 mtu 1460 type veth peer name uplink mtu 1460 netns ogc-"));
    assert!(host.contains("addr replace 198.18.0.4/31 dev ogc2"));
    let inner = link.namespace_commands(Tap::Missing);
    assert!(inner.contains("route replace default via 198.18.0.4 dev uplink"));
    assert!(inner.contains("tuntap add dev tap0 mode tap user 1002 group 1002"));
    assert!(inner.contains("neigh replace 169.254.0.21 lladdr 06:00:a9:fe:00:15"));

    // Repairing a network adds only what is missing and sets the rest.
    let host = link.host_commands(1460, true, true);
    assert!(!host.contains("netns add") && !host.contains("link add"));
    assert!(host.contains("link set dev ogc2 up"));
    let inner = link.namespace_commands(Tap::Fits);
    assert!(!inner.contains("tuntap"), "a live tap is never replaced");
    assert!(inner.contains("addr replace 169.254.0.22/30 dev tap0"));
    assert!(inner.contains("link set dev tap0 address 06:00:a9:fe:00:16"));

    // A tap someone else owns is replaced by one the VM may open.
    let inner = link.namespace_commands(Tap::Foreign);
    let replaced =
        "tuntap del dev tap0 mode tap\ntuntap add dev tap0 mode tap user 1002 group 1002";
    assert!(inner.contains(replaced), "{inner}");
}

#[test]
fn a_taps_owner_is_read_from_its_details() {
    let details = "3: tap0: <BROADCAST,UP> mtu 1500 qdisc fq_codel state DOWN mode DEFAULT group default qlen 1000\\    link/ether 06:00:a9:fe:00:16 brd ff:ff:ff:ff:ff:ff \\    tun type tap pi off vnet_hdr on persist on user 1073741843 group 1073741843 addrgenmode eui64";
    assert_eq!(
        tap_owner(details),
        (Some(1_073_741_843), Some(1_073_741_843))
    );
    assert_eq!(tap_owner("3: tap0: tun type tap persist on"), (None, None));
}

/// A sandbox's link is removed and another's, on the same ordinal and
/// so under the same host name, made at once, many times over, while
/// the kernel is still taking the old namespaces apart. Needs root and
/// a lab host: runs only when `COMPUTE_TEST_LAB` is set.
#[test]
fn a_link_name_is_free_again_as_soon_as_its_sandbox_is_removed() {
    const ORDINAL: u32 = 4000;
    let Some((_lab, config, networks)) = lab() else {
        return;
    };
    let addresses = config.addresses(ORDINAL).unwrap();
    let link = |n: u128| {
        let id = Id(SandboxId(0x00c0_ffee_0000 + n));
        (id, Link::new(id, ORDINAL, addresses, 1_000_000, 1_000_000))
    };
    let (mut id, first) = link(0);
    networks.ensure(&first).unwrap();
    for n in 1..=50 {
        let (next, made) = link(n % 2);
        networks.remove(id, Some(ORDINAL)).unwrap();
        assert!(
            !has_interface(&made.host).unwrap(),
            "round {n}: the old link is still there"
        );
        networks
            .ensure(&made)
            .unwrap_or_else(|error| panic!("round {n}: {error}"));
        id = next;
    }
    // A host end left by a namespace deleted behind the agent's back,
    // which may still be going away when the next sandbox is made.
    for n in 0..10 {
        let (_, gone) = link(n % 2);
        let (next, made) = link((n + 1) % 2);
        assert_eq!(gone.namespace, namespace_name(id));
        run("ip", &["netns", "del", &gone.namespace], None).unwrap();
        networks
            .ensure(&made)
            .unwrap_or_else(|error| panic!("leftover {n}: {error}"));
        id = next;
    }
    networks.remove(id, Some(ORDINAL)).unwrap();
    assert!(!has_interface(&first.host).unwrap());

    // Left over from an earlier run with other ordinals: sandbox `a`'s
    // namespace is paired with the next ordinal's host end, and this
    // ordinal's host end with sandbox `b`'s namespace. Making `a`'s
    // link on this ordinal clears both and pairs it right.
    let next = config.addresses(ORDINAL + 1).unwrap();
    let (a, b) = (
        Id(SandboxId(0x00c0_ffee_1000)),
        Id(SandboxId(0x00c0_ffee_1001)),
    );
    let cross = Link::new(a, ORDINAL + 1, next, 1_000_000, 1_000_000);
    networks.ensure(&cross).unwrap();
    networks
        .ensure(&Link::new(b, ORDINAL, addresses, 1_000_000, 1_000_000))
        .unwrap();
    let right = Link::new(a, ORDINAL, addresses, 1_000_000, 1_000_000);
    assert!(!paired(&right));
    networks.ensure(&right).unwrap();
    assert!(paired(&right), "the leftover pairs were not cleared");
    assert!(
        !has_interface(&cross.host).unwrap(),
        "a stale host end was left"
    );
    networks.ensure(&right).unwrap();
    assert!(paired(&right), "a whole pair was replaced");
    // `b` no longer holds the ordinal: only `a` may delete its host end.
    networks.remove(a, Some(ORDINAL)).unwrap();
    networks.remove(b, None).unwrap();
    assert!(!has_interface(&right.host).unwrap());
}

/// Failing to look at either end of a whole pair never deletes it.
#[test]
fn a_pair_that_cannot_be_looked_at_is_left_alone() {
    const ORDINAL: u32 = 4002;
    let Some((_lab, config, networks)) = lab() else {
        return;
    };
    let id = Id(SandboxId(0x00c0_ffee_2000));
    let link = Link::new(
        id,
        ORDINAL,
        config.addresses(ORDINAL).unwrap(),
        1_000_000,
        1_000_000,
    );
    networks.ensure(&link).unwrap();
    let before = veth_ends(&link.host).unwrap();
    for end in [link.host.as_str(), UPLINK] {
        fail_at(end, "inspect");
        let ensured = networks.ensure(&link);
        heal(end);
        assert!(ensured.is_err(), "{end} was not looked at");
        assert_eq!(
            veth_ends(&link.host).unwrap(),
            before,
            "the pair was replaced"
        );
        assert!(paired(&link));
    }
    networks.remove(id, Some(ORDINAL)).unwrap();
    assert!(!has_interface(&link.host).unwrap());
}

/// A process still inside a removed sandbox's namespace keeps the
/// namespace alive, but not its link. A removal that failed after the
/// namespace's name went still knows the host end, so a retry deletes
/// it, and the name is free for the next sandbox at once.
#[test]
fn a_retried_removal_finishes_while_the_namespace_lives_on() {
    const ORDINAL: u32 = 4004;
    let Some((_lab, config, networks)) = lab() else {
        return;
    };
    let addresses = config.addresses(ORDINAL).unwrap();
    let (id, next) = (
        Id(SandboxId(0x00c0_ffee_3000)),
        Id(SandboxId(0x00c0_ffee_3001)),
    );
    let link = Link::new(id, ORDINAL, addresses, 1_000_000, 1_000_000);
    // The record's ordinal, another one the namespace was not paired
    // with, and none, as for a sandbox without a record.
    for known in [Some(ORDINAL), Some(ORDINAL + 1), None] {
        networks.ensure(&link).unwrap();
        let holder = File::open(link.namespace_path()).unwrap();

        fail_at(UPLINK, "delete");
        let removed = networks.remove(id, known);
        heal(UPLINK);
        assert!(
            removed.is_err(),
            "{known:?}: a removal with a link left succeeded"
        );
        assert!(
            link.namespace_path().exists(),
            "{known:?}: the namespace's name went before its link"
        );
        assert!(has_interface(&link.host).unwrap(), "{known:?}");

        networks.remove(id, known).unwrap();
        assert!(
            !has_interface(&link.host).unwrap(),
            "{known:?}: the retry forgot the host end"
        );
        assert!(!link.namespace_path().exists(), "{known:?}");
        let made = Link::new(next, ORDINAL, addresses, 1_000_000, 1_000_000);
        networks.ensure(&made).unwrap();
        assert!(paired(&made), "{known:?}");
        drop(holder);
        networks.remove(next, Some(ORDINAL)).unwrap();
        assert!(!has_interface(&made.host).unwrap(), "{known:?}");
    }
}

/// Whether `link`'s host end and its namespace's uplink are one pair.
fn paired(link: &Link) -> bool {
    let uplink = in_namespace(&link.namespace_path(), || veth_ends(UPLINK)).unwrap();
    matches!((veth_ends(&link.host).unwrap(), uplink), (Some(host), Some(uplink)) if host.paired_with(uplink))
}
