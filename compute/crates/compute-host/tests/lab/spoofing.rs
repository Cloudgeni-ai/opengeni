//! Guests that forge addresses: a foreign IPv4 source, a changed MAC
//! address, IPv6 of their own making, and ARP claims to others' addresses.
//!
//! Each forged packet is a UDP datagram carrying a token, sent to a
//! listener this test controls; none may ever arrive. The sandbox's tap
//! counts what the guest put on the wire, so a packet the guest never sent
//! cannot pass for one the host stopped.

use std::io::{BufRead, BufReader};
use std::net::UdpSocket;
use std::sync::Mutex;

use super::*;

/// The guest's own MAC address, which the host knows it by.
const GUEST_MAC: &str = "06:00:a9:fe:00:15";
/// A MAC address the guest takes instead.
const FORGED_MAC: &str = "06:00:00:00:00:99";
/// The guest's gateway: its sandbox namespace's end of the tap.
const GATEWAY: &str = "169.254.0.22";
/// The guest's own address.
const GUEST: &str = "169.254.0.21";
/// The host's end of the first and second sandboxes' links.
const HOST_LINKS: [&str; 2] = ["198.18.0.0", "198.18.0.2"];
/// What every forged datagram starts with.
const FORGED: &str = "forged";

/// Sends a UDP datagram to each target after the source address (`-` for
/// the guest's own) and the case name, and prints `target outcome`:
/// `sent`, or the error sending failed with.
const SEND: &str = r#"
import errno, socket, sys
source, case = sys.argv[1], sys.argv[2]
for target in sys.argv[3:]:
    host, port = target.rsplit(":", 1)
    host = host.strip("[]")
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(family, socket.SOCK_DGRAM)
    try:
        if source != "-":
            s.bind((source, 0))
        address = socket.getaddrinfo(host, int(port), family, socket.SOCK_DGRAM)[0][4]
        s.sendto(("forged %s %s" % (case, target)).encode(), address)
        outcome = "sent"
    except OSError as error:
        outcome = errno.errorcode.get(error.errno, str(error.errno))
    print(target, outcome, flush=True)
    s.close()
"#;

/// Announces, from the MAC address given first, that it owns each IPv4
/// address given after it, as both an ARP request and a reply, and prints
/// `address announced`.
const ANNOUNCE: &str = r#"
import socket, struct, sys
mac = bytes.fromhex(sys.argv[1].replace(":", ""))
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
s.bind(("eth0", 0))
for ip in sys.argv[2:]:
    address = socket.inet_aton(ip)
    for op, target in ((1, b"\x00" * 6), (2, b"\xff" * 6)):
        arp = struct.pack("!HHBBH", 1, 0x0800, 6, 4, op) + mac + address + target + address
        s.send(b"\xff" * 6 + mac + b"\x08\x06" + arp)
    print(ip, "announced", flush=True)
"#;

/// The text of every datagram some listener received.
#[derive(Clone, Default)]
struct Received(Arc<Mutex<Vec<String>>>);

impl Received {
    fn push(&self, text: String) {
        self.0.lock().unwrap().push(text);
    }

    fn contains(&self, text: &str) -> bool {
        self.0.lock().unwrap().iter().any(|seen| seen == text)
    }

    fn forged(&self) -> Vec<String> {
        let seen = self.0.lock().unwrap();
        seen.iter()
            .filter(|text| text.starts_with(FORGED))
            .cloned()
            .collect()
    }
}

/// A UDP listener on every host address, IPv4 and IPv6, proven to
/// receive, and its port.
fn listen_on_host(received: &Received) -> u16 {
    let socket = UdpSocket::bind("[::]:0")
        .or_else(|_| UdpSocket::bind("0.0.0.0:0"))
        .unwrap();
    let port = socket.local_addr().unwrap().port();
    let into = received.clone();
    std::thread::spawn(move || {
        let mut buffer = [0; 512];
        while let Ok((length, _)) = socket.recv_from(&mut buffer) {
            into.push(String::from_utf8_lossy(&buffer[..length]).into_owned());
        }
    });
    let control = "control host";
    let sender = UdpSocket::bind("0.0.0.0:0").unwrap();
    await_control(received, control, || {
        sender
            .send_to(control.as_bytes(), ("127.0.0.1", port))
            .unwrap();
    });
    port
}

/// A UDP listener on every address of sandbox `id`'s namespace (IPv4 only
/// if the namespace has no IPv6), proven to receive from inside it. Ends
/// when dropped.
struct NamespaceInbox(Child);

impl NamespaceInbox {
    fn start(id: Id, port: u16, received: &Received) -> Self {
        let namespace = format!("ogc-{id}");
        let program = format!(
            "import socket
try:
    s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    s.bind(('::', {port}))
except OSError:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(('0.0.0.0', {port}))
while True:
    print(s.recv(512).decode(errors='replace'), flush=True)"
        );
        let mut child = Command::new("ip")
            .args(["netns", "exec", &namespace, "python3", "-c", &program])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap());
        let into = received.clone();
        std::thread::spawn(move || {
            for line in lines.lines().map_while(Result::ok) {
                into.push(line);
            }
        });
        let inbox = Self(child);
        let control = format!("control {namespace}");
        let send = format!(
            "import socket\nsocket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'{control}', ('127.0.0.1', {port}))"
        );
        await_control(received, &control, || {
            Command::new("ip")
                .args(["netns", "exec", &namespace, "python3", "-c", &send])
                .status()
                .unwrap();
        });
        inbox
    }
}

impl Drop for NamespaceInbox {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The positive control: sends `control` until `received` has it.
fn await_control(received: &Received, control: &str, mut send: impl FnMut()) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !received.contains(control) {
        assert!(
            std::time::Instant::now() < deadline,
            "a listener never received {control}"
        );
        send();
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Frames the guest of sandbox `id` has put on its tap.
fn sent_by_guest(id: Id) -> u64 {
    let output = Command::new("ip")
        .args([
            "netns",
            "exec",
            &format!("ogc-{id}"),
            "cat",
            "/sys/class/net/tap0/statistics/rx_packets",
        ])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .unwrap()
}

/// The neighbour table of sandbox `id`'s namespace, then the host's.
fn neighbours(id: Id) -> String {
    let namespace = format!("ogc-{id}");
    let mut table = String::new();
    for args in [
        vec!["-n", namespace.as_str(), "neigh", "show"],
        vec!["neigh", "show"],
    ] {
        let output = Command::new("ip").args(args).output().unwrap();
        table.push_str(&String::from_utf8_lossy(&output.stdout));
    }
    table
}

/// A guest command sending forged datagrams; see [`SEND`].
fn send_from(source: &str, case: &str, targets: &[String]) -> String {
    format!("python3 -c '{SEND}' {source} {case} {}", targets.join(" "))
}

/// Runs `script` in the first sandbox's guest and returns the rows it
/// printed for the datagrams it sent, one per target.
async fn send(client: &Client, script: &str, targets: &[String]) -> Vec<String> {
    let (output, _) = exec(client, id(0), script).await;
    let rows: Vec<String> = output
        .lines()
        .filter(|line| {
            targets
                .iter()
                .any(|target| line.starts_with(&format!("{target} ")))
        })
        .map(str::to_owned)
        .collect();
    assert_eq!(rows.len(), targets.len(), "{script}: {output}");
    rows
}

/// Forged packets from the first sandbox's guest reach no listener on the
/// host, in its own namespace or in the second sandbox's namespace, and
/// forged ARP claims change no neighbour table; after them, the probes of
/// `targets` (the first is `lan`) still meet the firewall as
/// [`check_probes`] expects.
pub(super) async fn check_spoofing(client: &Client, targets: &[String], lan: &str, trusted: bool) {
    let received = Received::default();
    let port = listen_on_host(&received);
    let _own = NamespaceInbox::start(id(0), port, &received);
    let _neighbour = NamespaceInbox::start(id(1), port, &received);
    let hosts = host_addresses();
    let (v4, v6) = listeners(&hosts, port);
    let before = sent_by_guest(id(0));
    let mut sent = 0;
    for source in ["203.0.113.7", NEIGHBOUR_INNER] {
        let script = format!(
            "ip addr add {source}/32 dev eth0\n{}\nip addr del {source}/32 dev eth0",
            send_from(source, "source", &v4)
        );
        let rows = send(client, &script, &v4).await;
        assert!(rows.iter().all(|row| row.ends_with(" sent")), "{rows:?}");
        sent += rows.len();
    }
    let script = format!(
        "ip link set dev eth0 address {FORGED_MAC}\n{}\nip link set dev eth0 address {GUEST_MAC}",
        send_from("-", "mac", &v4)
    );
    let rows = send(client, &script, &v4).await;
    assert!(rows.iter().all(|row| row.ends_with(" sent")), "{rows:?}");
    sent += rows.len();
    // The guest has no IPv6 address or route of its own; it makes both.
    let script = format!(
        "ip -6 addr add fd00::7/64 dev eth0 nodad\nip -6 route add default dev eth0\n{}\nip -6 route del default dev eth0\nip -6 addr del fd00::7/64 dev eth0",
        send_from("-", "ipv6", &v6)
    );
    let rows = send(client, &script, &v6).await;
    assert!(
        rows.iter()
            .any(|row| row.starts_with("[ff02::1") && row.ends_with(" sent")),
        "the guest sent no IPv6 at all: {rows:?}"
    );

    sent += claim_addresses(client, &hosts).await;
    // After the claims, datagrams from the guest's own address still reach
    // none of the listeners, and blocked connections still meet the
    // firewall.
    let rows = send(client, &send_from("-", "after-arp", &v4), &v4).await;
    sent += rows.len();
    let (output, _) = exec(client, id(0), &probe_script(targets)).await;
    let lines: Vec<&str> = output.lines().collect();
    let open: &[&str] = if trusted { &[lan] } else { &[] };
    check_probes(
        &format!("after ARP, trusted={trusted}"),
        &lines,
        targets,
        open,
    );

    sleep(Duration::from_secs(1)).await;
    let wire = sent_by_guest(id(0)) - before;
    assert!(
        wire >= u64::try_from(sent).unwrap(),
        "the guest put {wire} frames on its tap, fewer than the {sent} it was asked to"
    );
    let forged = received.forged();
    assert!(forged.is_empty(), "forged packets arrived: {forged:?}");
    check_neighbours();
}

/// Each listener's address as an IPv4 and an IPv6 target on `port`:
/// the guest's gateway, the second sandbox's namespace, the host's ends of
/// both links and the host's addresses; for IPv6 also every node on the
/// guest's link and an address the guest's own made-up network holds.
fn listeners(hosts: &[IpAddr], port: u16) -> (Vec<String>, Vec<String>) {
    let at = |address: &str| target(address.parse().unwrap(), port);
    let mut v4: Vec<String> = [GATEWAY, NEIGHBOUR_INNER]
        .into_iter()
        .chain(HOST_LINKS)
        .map(at)
        .collect();
    let mut v6: Vec<String> = vec![
        format!("[{GATEWAY_LINK_LOCAL}]:{port}"),
        format!("[ff02::1%eth0]:{port}"),
        format!("[fd00::1]:{port}"),
    ];
    for address in hosts {
        if address.is_ipv4() { &mut v4 } else { &mut v6 }.push(target(*address, port));
    }
    (v4, v6)
}

/// The first sandbox's guest claims the gateway's, its own, the second
/// sandbox's, the host links' and the host's IPv4 addresses, from a forged
/// MAC and from its own. Returns how many frames it sent.
async fn claim_addresses(client: &Client, hosts: &[IpAddr]) -> usize {
    let mut claimed: Vec<String> = [GATEWAY, GUEST, NEIGHBOUR_INNER]
        .into_iter()
        .chain(HOST_LINKS)
        .map(str::to_owned)
        .collect();
    claimed.extend(
        hosts
            .iter()
            .filter(|address| address.is_ipv4())
            .map(ToString::to_string),
    );
    let mut sent = 0;
    for mac in [FORGED_MAC, GUEST_MAC] {
        let script = format!("python3 -c '{ANNOUNCE}' {mac} {}", claimed.join(" "));
        let (output, _) = exec(client, id(0), &script).await;
        let announced = output
            .lines()
            .filter(|line| line.ends_with(" announced"))
            .count();
        assert_eq!(announced, claimed.len(), "{output}");
        sent += 2 * claimed.len();
    }
    sent
}

/// The first sandbox's namespace still knows only the guest's own address
/// at the guest's MAC, and nothing anywhere learned the forged MAC.
fn check_neighbours() {
    let table = neighbours(id(0));
    assert!(
        table.contains(&format!("{GUEST} dev tap0 lladdr {GUEST_MAC} PERMANENT")),
        "the guest's neighbour entry changed: {table}"
    );
    for line in table.lines() {
        assert!(
            !line.contains(FORGED_MAC),
            "a forged MAC was learned: {line}"
        );
        assert!(
            !line.contains(GUEST_MAC) || line.starts_with(&format!("{GUEST} ")),
            "the guest's MAC was learned for another address: {line}"
        );
    }
}
