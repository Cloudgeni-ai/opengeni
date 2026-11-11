# The Homebrew cask for the Opengeni desktop app. The desktop release workflow
# fills in the version and checksum and publishes it to the Cloudgeni-ai/tap
# tap, so `brew install --cask cloudgeni-ai/tap/opengeni` installs the newest
# release. The app updates itself afterwards.
cask "opengeni" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/Cloudgeni-ai/opengeni/releases/download/desktop-v#{version}/Opengeni-#{version}-mac.dmg"
  name "Opengeni"
  desc "Work with your agents from the desktop"
  homepage "https://github.com/Cloudgeni-ai/opengeni"

  livecheck do
    url "https://github.com/Cloudgeni-ai/opengeni.git"
    regex(/^desktop-v(\d+(?:\.\d+)+)$/i)
  end

  auto_updates true
  depends_on macos: :monterey

  app "Opengeni.app"

  uninstall quit: "ai.opengeni.desktop"

  zap trash: [
    "~/Library/Application Support/Opengeni",
    "~/Library/Caches/ai.opengeni.desktop",
    "~/Library/Caches/ai.opengeni.desktop.ShipIt",
    "~/Library/HTTPStorages/ai.opengeni.desktop",
    "~/Library/Logs/Opengeni",
    "~/Library/Preferences/ai.opengeni.desktop.plist",
    "~/Library/Saved Application State/ai.opengeni.desktop.savedState",
  ]
end
