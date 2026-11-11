//! What the host agent tells the guest on the kernel command line.
//!
//! Two arguments matter: `opengeni.sandbox=<id>`, the sandbox the guest
//! was booted for, and the kernel's own `ip=` argument, which carries the
//! fixed guest network (ADR 11):
//!
//! ```text
//! ip=<client>:<server>:<gateway>:<netmask>:<hostname>:<device>:<autoconf>:<dns0>:<dns1>
//! ```

use std::fmt::Write as _;
use std::net::Ipv4Addr;

/// The kernel argument that names the sandbox.
pub const SANDBOX_ARG: &str = "opengeni.sandbox";

/// The arguments the guest acts on.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BootArgs {
    /// The sandbox id, if it is a valid one.
    pub sandbox: Option<String>,
    /// The network, if `ip=` names a static one.
    pub network: Option<Network>,
}

/// A static IPv4 network from `ip=`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Network {
    pub address: Ipv4Addr,
    pub gateway: Option<Ipv4Addr>,
    pub netmask: Ipv4Addr,
    pub device: String,
    pub dns: Vec<Ipv4Addr>,
}

impl BootArgs {
    /// Reads the arguments out of `/proc/cmdline`'s text. Later arguments
    /// win, as in the kernel; arguments it does not know are ignored.
    #[must_use]
    pub fn parse(cmdline: &str) -> Self {
        let mut args = Self::default();
        for arg in cmdline.split_whitespace() {
            if let Some(id) = arg
                .strip_prefix(SANDBOX_ARG)
                .and_then(|r| r.strip_prefix('='))
            {
                args.sandbox = valid_sandbox(id).then(|| id.to_owned());
            } else if let Some(ip) = arg.strip_prefix("ip=") {
                args.network = Network::parse(ip);
            }
        }
        args
    }
}

/// Whether `id` can name a sandbox: it becomes a host name and a file's
/// contents, so it is held to letters, digits and dashes.
#[must_use]
pub fn valid_sandbox(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl Network {
    /// Parses the value of `ip=`. Returns `None` for anything but a static
    /// address with a netmask and a device (`dhcp`, `off` and the like).
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        let fields: Vec<&str> = value.split(':').collect();
        let field = |n: usize| fields.get(n).copied().unwrap_or("");
        let address = field(0).parse().ok()?;
        let gateway = field(2).parse().ok();
        let netmask = field(3).parse().ok()?;
        let device = field(5);
        if device.is_empty() || device.len() >= 16 {
            return None;
        }
        let dns = [field(7), field(8)]
            .into_iter()
            .filter_map(|server| server.parse().ok())
            .collect();
        Some(Self {
            address,
            gateway,
            netmask,
            device: device.to_owned(),
            dns,
        })
    }

    /// `/etc/resolv.conf` for this network's name servers.
    #[must_use]
    pub fn resolv_conf(&self) -> String {
        self.dns.iter().fold(String::new(), |mut text, server| {
            let _ = writeln!(text, "nameserver {server}");
            text
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "console=ttyS0 reboot=k panic=1 opengeni.sandbox=00000000000001ab0000000000000003 \
        ip=169.254.0.21::169.254.0.22:255.255.255.252::eth0:off:1.1.1.1:8.8.8.8 clocksource=kvm-clock";

    #[test]
    fn reads_what_the_host_agent_passes() {
        let args = BootArgs::parse(HOST);
        assert_eq!(
            args.sandbox.as_deref(),
            Some("00000000000001ab0000000000000003")
        );
        let network = args.network.unwrap();
        assert_eq!(network.address, Ipv4Addr::new(169, 254, 0, 21));
        assert_eq!(network.gateway, Some(Ipv4Addr::new(169, 254, 0, 22)));
        assert_eq!(network.netmask, Ipv4Addr::new(255, 255, 255, 252));
        assert_eq!(network.device, "eth0");
        assert_eq!(
            network.resolv_conf(),
            "nameserver 1.1.1.1\nnameserver 8.8.8.8\n"
        );
    }

    #[test]
    fn ignores_what_it_cannot_use() {
        assert_eq!(BootArgs::parse(""), BootArgs::default());
        assert_eq!(
            BootArgs::parse("ip=dhcp opengeni.sandbox="),
            BootArgs::default()
        );
        assert_eq!(
            BootArgs::parse("opengeni.sandbox=a/b ip=10.0.0.2::10.0.0.1:255.0.0.0::eth0"),
            BootArgs {
                sandbox: None,
                network: Network::parse("10.0.0.2::10.0.0.1:255.0.0.0::eth0"),
            }
        );
        // No device, no netmask or a device name the kernel cannot hold.
        assert_eq!(Network::parse("10.0.0.2::10.0.0.1:255.0.0.0::"), None);
        assert_eq!(Network::parse("10.0.0.2::10.0.0.1:::eth0"), None);
        assert_eq!(
            Network::parse("10.0.0.2:::255.0.0.0::a-very-long-device"),
            None
        );
        assert_eq!(BootArgs::parse("opengeni.sandboxes=x").sandbox, None);
    }

    #[test]
    fn later_arguments_win_and_gateway_and_dns_are_optional() {
        let args =
            BootArgs::parse("opengeni.sandbox=a opengeni.sandbox=b ip=10.0.0.2::x:255.0.0.0::eth1");
        assert_eq!(args.sandbox.as_deref(), Some("b"));
        let network = args.network.unwrap();
        assert_eq!(network.gateway, None);
        assert_eq!(network.dns, Vec::<Ipv4Addr>::new());
        assert_eq!(network.resolv_conf(), "");
    }

    #[test]
    fn sandbox_ids_are_letters_digits_and_dashes() {
        assert!(valid_sandbox("abc-DEF-123"));
        for bad in ["", "a b", "a\n", "../x", "a.b", &"a".repeat(129)] {
            assert!(!valid_sandbox(bad), "{bad:?}");
        }
    }
}
