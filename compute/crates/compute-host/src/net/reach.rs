//! What sandboxes may reach besides the internet: an exact list of
//! destinations and the TCP ports guests may open there.
//!
//! A host's local network, its overlay network and its cloud's private
//! services are all closed to guests. Some deployments need a few of them,
//! such as an Opengeni whose API and object storage only a private network
//! serves. Each `--reach` entry opens exactly one destination's listed
//! ports, in the same two firewalls that close everything else, and a name
//! in an entry is also answered by the sandboxes' name server
//! ([`super::dns`]). Nothing else private becomes reachable, and the host's
//! own name server, which knows the names of the whole private network, is
//! never asked for a guest.
//!
//! Names are resolved by the host once, when the agent starts: each name
//! is looked up once however many entries give it, and those addresses are
//! both what guests are told and what the firewalls open for every port
//! any of its entries lists, so the two always agree. A name that moves to
//! another address takes effect when the agent next starts; its sandboxes
//! keep running meanwhile (ADR 9).

use std::collections::BTreeMap;
use std::fmt::{self, Write as _};
use std::net::Ipv4Addr;
use std::str::FromStr;

use super::Ipv4Net;

/// Addresses one name may resolve to that guests are told about; more are
/// dropped, as one DNS answer must stay small.
const MAX_ADDRESSES: usize = 16;

/// One destination sandboxes may reach, and the TCP ports they may open
/// there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reach {
    pub target: Target,
    pub ports: Vec<Ports>,
}

/// Where a [`Reach`] leads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// A DNS name, in lower case without a final dot.
    Name(String),
    /// An address, or a range of them.
    Net(Ipv4Net),
}

/// A TCP port, or an inclusive range of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ports {
    pub first: u16,
    pub last: u16,
}

impl fmt::Display for Ports {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.first == self.last {
            write!(f, "{}", self.first)
        } else {
            write!(f, "{}-{}", self.first, self.last)
        }
    }
}

impl Ports {
    /// Whether `port` is one of them.
    pub(crate) fn contains(self, port: u16) -> bool {
        (self.first..=self.last).contains(&port)
    }
}

impl FromStr for Ports {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let port = |text: &str| match text.parse::<u16>() {
            Ok(0) | Err(_) => Err(format!("{text} is not a TCP port (1 to 65535)")),
            Ok(port) => Ok(port),
        };
        let (first, last) = match text.split_once('-') {
            Some((first, last)) => (port(first)?, port(last)?),
            None => (port(text)?, port(text)?),
        };
        if first > last {
            return Err(format!("{text}: the range ends before it starts"));
        }
        Ok(Self { first, last })
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Name(name) => f.write_str(name),
            Self::Net(net) if net.prefix == 32 => write!(f, "{}", net.address),
            Self::Net(net) => write!(f, "{net}"),
        }
    }
}

impl fmt::Display for Reach {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:", self.target)?;
        for (n, ports) in self.ports.iter().enumerate() {
            if n > 0 {
                f.write_str(",")?;
            }
            write!(f, "{ports}")?;
        }
        Ok(())
    }
}

/// Parses `DESTINATION:PORTS`: the destination a DNS name, an address or
/// `address/prefix`, the ports a comma-separated list of ports and
/// `first-last` ranges, such as `api.internal:443,9443-9445`.
impl FromStr for Reach {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let (target, ports) = text
            .rsplit_once(':')
            .ok_or_else(|| format!("{text} is not DESTINATION:PORTS"))?;
        let target = if target.contains('/') {
            Target::Net(target.parse()?)
        } else if let Ok(address) = target.parse::<Ipv4Addr>() {
            Target::Net(Ipv4Net {
                address,
                prefix: 32,
            })
        } else {
            Target::Name(dns_name(target).ok_or_else(|| {
                format!("{target} is neither an IPv4 address, a range nor a DNS name")
            })?)
        };
        let ports = ports
            .split(',')
            .map(str::parse)
            .collect::<Result<Vec<Ports>, _>>()
            .map_err(|error| format!("{text}: {error}"))?;
        Ok(Self { target, ports })
    }
}

/// `text` as a DNS name in lower case without a final dot, if it is one:
/// labels of letters, digits and inner hyphens, at most 63 bytes each and
/// 253 in all, the last not all digits.
pub(crate) fn dns_name(text: &str) -> Option<String> {
    let name = text.strip_suffix('.').unwrap_or(text).to_ascii_lowercase();
    let labels: Vec<&str> = name.split('.').collect();
    let label_ok = |label: &&str| {
        (1..=63).contains(&label.len())
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    let last_ok = labels
        .last()
        .is_some_and(|last| !last.bytes().all(|b| b.is_ascii_digit()));
    (name.len() <= 253 && labels.iter().all(label_ok) && last_ok).then_some(name)
}

impl Ipv4Net {
    /// Whether the two ranges share an address.
    pub(crate) fn overlaps(self, other: Self) -> bool {
        let prefix = self.prefix.min(other.prefix);
        let mask = Self::mask(prefix);
        u32::from(self.address) & mask == u32::from(other.address) & mask
    }
}

/// The `--reach` entries with every name resolved: what the firewalls open
/// and what the sandboxes' name server answers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Allowed {
    /// Each destination range, once, with every port guests may open
    /// there.
    pub open: Vec<(Ipv4Net, Vec<Ports>)>,
    /// Each name with the addresses guests are told.
    pub names: BTreeMap<String, Vec<Ipv4Addr>>,
}

impl Allowed {
    /// Resolves `reach`, looking each name up once with `lookup`, and
    /// checks that nothing it opens is a range guests may never reach
    /// (`never`). Entries that lead to the same destination open the
    /// ports of all of them there.
    ///
    /// # Errors
    ///
    /// A name that does not resolve to an IPv4 address, or a destination
    /// that overlaps one of `never`.
    pub fn resolve(
        reach: &[Reach],
        never: &[Ipv4Net],
        mut lookup: impl FnMut(&str) -> Result<Vec<Ipv4Addr>, String>,
    ) -> Result<Self, String> {
        let mut allowed = Self::default();
        for entry in reach {
            let nets = match &entry.target {
                Target::Net(net) => vec![*net],
                Target::Name(name) => {
                    let addresses = if let Some(known) = allowed.names.get(name) {
                        known.clone()
                    } else {
                        let mut addresses = lookup(name)?;
                        addresses.sort_unstable();
                        addresses.dedup();
                        addresses.truncate(MAX_ADDRESSES);
                        if addresses.is_empty() {
                            return Err(format!("{name} has no IPv4 address"));
                        }
                        allowed.names.insert(name.clone(), addresses.clone());
                        addresses
                    };
                    addresses
                        .into_iter()
                        .map(|address| Ipv4Net {
                            address,
                            prefix: 32,
                        })
                        .collect()
                }
            };
            for net in nets {
                if let Some(closed) = never.iter().find(|closed| closed.overlaps(net)) {
                    return Err(format!(
                        "--reach {entry}: {net} is in {closed}, which sandboxes may never reach"
                    ));
                }
                allowed.open_ports(net, &entry.ports);
            }
        }
        Ok(allowed)
    }

    /// Adds `ports` to what guests may open at `net`.
    fn open_ports(&mut self, net: Ipv4Net, ports: &[Ports]) {
        let index = if let Some(index) = self.open.iter().position(|(known, _)| *known == net) {
            index
        } else {
            self.open.push((net, Vec::new()));
            self.open.len() - 1
        };
        let open = &mut self.open[index].1;
        for ports in ports {
            if !open.contains(ports) {
                open.push(*ports);
            }
        }
    }

    /// One nftables rule per destination, each `prefix` followed by the
    /// destination's match and `accept`.
    pub fn accept_rules(&self, prefix: &str) -> String {
        let mut rules = String::new();
        for (net, ports) in &self.open {
            let ports: Vec<String> = ports.iter().map(ToString::to_string).collect();
            let _ = writeln!(
                rules,
                "        {prefix} ip daddr {net} tcp dport {{ {} }} accept",
                ports.join(", ")
            );
        }
        rules
    }

    /// What the entries opened, for the log.
    pub fn describe(&self) -> String {
        let mut lines: Vec<String> = self
            .open
            .iter()
            .map(|(net, ports)| {
                let ports: Vec<String> = ports.iter().map(ToString::to_string).collect();
                format!("{net} tcp {}", ports.join(","))
            })
            .collect();
        lines.extend(self.names.iter().map(|(name, addresses)| {
            let addresses: Vec<String> = addresses.iter().map(ToString::to_string).collect();
            format!("{name} = {}", addresses.join(","))
        }));
        lines.join("; ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn net(text: &str) -> Ipv4Net {
        text.parse().unwrap()
    }

    #[test]
    fn entries_parse_names_addresses_ranges_and_ports() {
        let entry: Reach = "API.Example.COM.:443,9443-9445".parse().unwrap();
        assert_eq!(entry.target, Target::Name("api.example.com".into()));
        assert_eq!(
            entry.ports,
            [
                Ports {
                    first: 443,
                    last: 443
                },
                Ports {
                    first: 9443,
                    last: 9445
                }
            ]
        );
        assert_eq!(entry.to_string(), "api.example.com:443,9443-9445");
        let address: Reach = "10.1.2.3:5432".parse().unwrap();
        assert_eq!(address.target, Target::Net(net("10.1.2.3/32")));
        assert_eq!(address.to_string(), "10.1.2.3:5432");
        let range: Reach = "10.8.0.0/16:80".parse().unwrap();
        assert_eq!(range.target, Target::Net(net("10.8.0.0/16")));
        let single: Reach = "minio:9000".parse().unwrap();
        assert_eq!(single.target, Target::Name("minio".into()));
        for bad in [
            "api.example.com",
            "api.example.com:",
            "api.example.com:0",
            "api.example.com:65536",
            "api.example.com:9445-9443",
            "api.example.com:http",
            "10.8.0.1/16:80",
            "-bad.example:80",
            "bad_name.example:80",
            "1.2.3:80",
            ":443",
            "[::1]:443",
        ] {
            assert!(bad.parse::<Reach>().is_err(), "{bad}");
        }
    }

    #[test]
    fn ranges_overlap_when_they_share_an_address() {
        assert!(net("10.0.0.0/8").overlaps(net("10.20.0.0/16")));
        assert!(net("10.20.0.0/16").overlaps(net("10.0.0.0/8")));
        assert!(net("10.20.0.7/32").overlaps(net("10.20.0.7/32")));
        assert!(!net("10.20.0.7/32").overlaps(net("10.20.0.8/32")));
        assert!(!net("169.254.0.0/16").overlaps(net("100.64.0.0/10")));
        assert!(net("0.0.0.0/0").overlaps(net("100.64.0.0/10")));
    }

    #[test]
    fn names_resolve_to_what_the_firewall_opens_and_guests_are_told() {
        let reach: Vec<Reach> = ["api.example:443,9443", "api.example:9445", "10.9.0.0/24:22"]
            .iter()
            .map(|text| text.parse().unwrap())
            .collect();
        let never = [net("169.254.0.0/16"), net("198.18.0.0/15")];
        let mut asked = Vec::new();
        let allowed = Allowed::resolve(&reach, &never, |name| {
            asked.push(name.to_owned());
            Ok(vec![
                Ipv4Addr::new(100, 70, 0, 2),
                Ipv4Addr::new(100, 70, 0, 1),
                Ipv4Addr::new(100, 70, 0, 2),
            ])
        })
        .unwrap();
        // Asked once, though two entries give it.
        assert_eq!(asked, ["api.example"]);
        assert_eq!(
            allowed.names["api.example"],
            [Ipv4Addr::new(100, 70, 0, 1), Ipv4Addr::new(100, 70, 0, 2)]
        );
        let rules = allowed.accept_rules("iifname \"tap0\"");
        for address in ["100.70.0.1", "100.70.0.2"] {
            assert!(rules.contains(&format!(
                "iifname \"tap0\" ip daddr {address}/32 tcp dport {{ 443, 9443, 9445 }} accept"
            )));
        }
        assert!(rules.contains("ip daddr 10.9.0.0/24 tcp dport { 22 } accept"));
        assert_eq!(rules.lines().count(), 3);
        assert!(
            allowed
                .describe()
                .contains("api.example = 100.70.0.1,100.70.0.2")
        );
        assert_eq!(
            Allowed::resolve(&[], &never, |_| unreachable!()).unwrap(),
            Allowed::default()
        );
    }

    #[test]
    fn a_name_given_twice_opens_every_port_at_every_address_it_is_answered_with() {
        // A name server that answers each lookup with another address, as
        // round-robin DNS does.
        let reach: Vec<Reach> = [
            "api.example:443",
            "API.example.:8443",
            "100.70.0.1:22",
            "100.70.0.1:22,23",
        ]
        .iter()
        .map(|text| text.parse().unwrap())
        .collect();
        let mut answers = [Ipv4Addr::new(100, 70, 0, 1), Ipv4Addr::new(100, 70, 0, 2)]
            .into_iter()
            .cycle();
        let allowed = Allowed::resolve(&reach, &[], |_| Ok(vec![answers.next().unwrap()])).unwrap();
        let told = &allowed.names["api.example"];
        assert_eq!(told, &[Ipv4Addr::new(100, 70, 0, 1)]);
        let port = |port| Ports {
            first: port,
            last: port,
        };
        assert_eq!(
            allowed.open,
            [(
                net("100.70.0.1/32"),
                vec![port(443), port(8443), port(22), port(23)]
            )]
        );
    }

    #[test]
    fn what_guests_may_never_reach_cannot_be_opened() {
        let never = [
            net("169.254.0.0/16"),
            net("127.0.0.0/8"),
            net("198.18.0.0/15"),
        ];
        let reach = |text: &str| vec![text.parse::<Reach>().unwrap()];
        for closed in [
            "169.254.169.254:80",
            "127.0.0.1:22",
            "198.19.0.0/16:80",
            "0.0.0.0/0:443",
        ] {
            let refused = Allowed::resolve(&reach(closed), &never, |_| unreachable!());
            assert!(refused.is_err(), "{closed}");
        }
        // A name is checked by what it resolves to.
        let metadata = Allowed::resolve(&reach("metadata.internal:80"), &never, |_| {
            Ok(vec![Ipv4Addr::new(169, 254, 169, 254)])
        });
        assert!(metadata.unwrap_err().contains("may never reach"));
        let nothing = Allowed::resolve(&reach("gone.example:80"), &never, |_| Ok(Vec::new()));
        assert!(nothing.unwrap_err().contains("no IPv4 address"));
        let failed = Allowed::resolve(&reach("gone.example:80"), &never, |name| {
            Err(format!("{name}: no such name"))
        });
        assert!(failed.unwrap_err().contains("no such name"));
    }
}
