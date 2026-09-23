# @cubing-companion/mobile

The native shell. **No application code lives here** — it wraps `apps/web`'s static export, so the
phone runs exactly the bundle a browser runs: the same components, the same planner worker, the
same vendored protocol. What the shell adds is a native Bluetooth radio, which is the one thing a
browser on iOS cannot provide and the whole reason this directory exists.

[MOBILE_PLAN.md](../../MOBILE_PLAN.md) has the reasoning — why Capacitor rather than React Native,
and what the phases were.

```sh
npm run devices -w @cubing-companion/mobile   # list simulators and attached iPhones
npm run run:ios -w @cubing-companion/mobile   # rebuild, deploy, launch — pick a target
npm run sync -w @cubing-companion/mobile      # rebuild and copy into ios/, without running
npm run open:ios -w @cubing-companion/mobile  # open Xcode, for signing and device logs
```

`run:ios` rebuilds the web app first, so it is the one command to use after changing anything in
`apps/web`. The iOS project serves a *copy* of the build, not a live reference, so an un-synced
change simply will not appear.

A Simulator needs no signing and works immediately — but it has **no Bluetooth radio**, so the cube
cannot connect there. It is for looking at the app. A real phone needs the one-time signing setup
below, and is the only way to reach a cube.

## Running it on your iPhone

Free personal-team provisioning — no Apple Developer Program, no $99.

1. `npm run sync -w @cubing-companion/mobile`
2. `npm run open:ios -w @cubing-companion/mobile`
3. In Xcode: select the **App** target → **Signing & Capabilities** → tick *Automatically manage
   signing* → set **Team** to your personal Apple ID. Add the account under Xcode → Settings →
   Accounts if it is not listed.
4. Xcode will reject the bundle identifier if someone else has claimed it. Change it to something
   unique — `com.yourname.cubingcompanion` — in both Xcode and
   [capacitor.config.ts](capacitor.config.ts), keeping the two the same.
5. Plug the phone in, pick it as the run destination, press ▶.
6. First run only: the phone refuses to launch an app from an untrusted developer. Settings →
   General → VPN & Device Management → trust your certificate.

**Builds signed this way expire after seven days** and must be reinstalled from Xcode. That is the
cost of not paying for the Developer Program, which extends it to a year.

## What has been verified

**On a physical iPhone 11 (iOS 26.5.2): the app runs and the GAN i Carry 4 connects over native
Bluetooth.** That is the whole point of this directory, and it works.

Verified in the iOS Simulator as well, which is useful because it needs no signing:

- The app compiles and links, with the BLE plugin resolved through Swift Package Manager.
- The static export loads and renders under `capacitor://localhost`.
- **The twisty player renders in 3D** — WebGL works in WKWebView, which was the single largest
  open risk in the whole plan.
- `isNativeShell()` is true inside the shell, so the app selects the native Bluetooth transport
  rather than Web Bluetooth.

A Simulator has no Bluetooth radio, so anything involving the cube — scanning, MAC recovery,
decryption, the move stream — can only be checked on a real phone.

If a cube ever connects but the virtual cube then follows it incorrectly, check **Protocol
capture → MAC from**. Anything other than `advertisement` means the key was derived from a
remembered or typed address, and the frames may be decrypting to nonsense. The reasoning is in
[`packages/cube-link/src/ble/mac.ts`](../../packages/cube-link/src/ble/mac.ts).

## Getting past "Communication with Apple failed"

Xcode collapses every provisioning failure into that one string. Run the build from a terminal and
read the text *after* the colon:

```sh
cd ios/App && xcodebuild -scheme App -destination 'id=<device-id>' -allowProvisioningUpdates build
```

Three gates, in the order they bite:

1. **Developer Mode** must be on: iPhone → Settings → Privacy & Security → Developer Mode. The
   phone restarts. The menu only appears after the phone has been connected to Xcode once.
2. **The device must be registered** with your team. Free provisioning scopes profiles to specific
   devices, so with none registered Apple has nothing to generate against. Connecting the phone
   with Developer Mode on fixes this automatically.
3. **The certificate must be trusted on the phone**: Settings → General → VPN & Device Management
   → Developer App → Trust. Until then iOS installs the app but refuses to launch it.

## CocoaPods is not used

The iOS project is set up with **Swift Package Manager** (`cap add ios --packagemanager SPM`), so
there is no Podfile and no Ruby toolchain to install. If a future plugin turns out to be
CocoaPods-only, that is the point to reconsider.

## What is committed

The Xcode project, the Swift sources, `Info.plist` and the asset catalogue. Not the web copy in
`ios/App/App/public/`, not `capacitor.config.json`, and not build output — Capacitor's own
`ios/.gitignore` covers those, and all of them are regenerated by `sync`.

App icons and launch images come from the same generator as the web icons:

```sh
npm run generate-icons -w @cubing-companion/web
```

It writes into this project's asset catalogue when it is present, so the installed app looks like
the site it came from rather than shipping Capacitor's placeholder.
