# homebridge-rainforest-eagle3-abirismyname — Project Specification

A Homebridge plugin that exposes Rainforest Automation EAGLE-200 smart meter data to Apple HomeKit via an Eve Energy accessory with fakegato history support.

> **npm package name:** `homebridge-rainforest-eagle3-abirismyname` (unique to this fork). The Homebridge platform identifier remains `EAGLE`.

---

## Overview

`homebridge-eagle` polls the EAGLE-200 **local** HTTP API (same LAN only) and publishes a single **Grid Meter** HomeKit accessory showing real-time electricity demand, cumulative import, and cumulative export. It is designed to complement `homebridge-pvs6` — the two plugins are fully independent but sit alongside each other naturally in Apple Home and the Eve app.

The EAGLE-200 connects to the utility smart meter via ZigBee HAN (Home Area Network). It exposes live demand and summation data locally over plain HTTP — no cloud account or internet access required at runtime.

---

## Supported Hardware

| Device | Notes |
|---|---|
| Rainforest EAGLE-200 (RFA-Z114) | Local API; firmware Sep 2017 (v1.0) or later. **Primary target.** |
| Rainforest EAGLE-3 | Newer hardware that reportedly shares the same `post_manager` local API. **Unverified** against this plugin — expected to work if it uses the EAGLE-200 local API, but not tested. |
| Original EAGLE (Z109) | Uses a different relay-server REST API — **not supported** by this plugin |

This plugin targets the **EAGLE-200 local API only** (the `POST /cgi-bin/post_manager` XML-fragment interface documented in the *EAGLE-200 Local API Manual v1.0*). The EAGLE-3 is expected to be compatible because it exposes the same local API, but is treated as unverified. The cloud/relay-server API is a separate, older spec and is out of scope.

---

## Architecture

```
Homebridge (Node.js)
  └── homebridge-eagle plugin
        ├── EagleClient           — XML POST transport, device discovery, polling
        └── GridMeterAccessory    — Eve Energy + fakegato history
```

---

## API Overview

### Transport

- **Endpoint**: `POST http://<host>/cgi-bin/post_manager`  
  (also reachable via mDNS as `http://eagle-<CloudID>.local/cgi-bin/post_manager`)
- **Protocol**: Plain HTTP (not HTTPS)
- **Auth**: HTTP Basic, per-request. Username = Cloud ID (last 6 digits of Ethernet MAC), password = Install Code. Both printed on the label on the underside of the device.
- **Content-Type**: `text/xml`
- **Body**: XML fragment (not a full XML document — no `<?xml?>` declaration, no root element wrapper)
- **HTTP version**: **HTTP/1.0.** Sending the request as HTTP/1.0 makes the EAGLE respond with a `Content-Length` header and a single, complete body. Under HTTP/1.1 the EAGLE replies with `Transfer-Encoding: chunked`, which is best avoided here. Node's high-level HTTP client (and therefore `axios`) always negotiates HTTP/1.1 and cannot downgrade, so the request must be issued over a raw TCP socket (`net.Socket`) with a hand-built `HTTP/1.0` request line and headers, reading the response until the socket closes. See *Transport implementation* below.

### Authentication credential format

The `Authorization` header uses standard Basic Auth: Base64-encode `"<CloudID>:<InstallCode>"`.

Example: Cloud ID `004792`, Install Code `bfb0fc05f51a3932` →  
Base64(`004792:bfb0fc05f51a3932`) → `MDA0NzkyOmJmYjBmYzA1ZjUxYTM5MzI=`

### Request structure

```
POST /cgi-bin/post_manager HTTP/1.0
Host: <host>
Content-type: text/xml
Content-Length: <n>
Authorization: Basic <base64credential>

<Command>
  <Name>...</Name>
  ...
</Command>
```

Every line (request line, each header, the blank separator line, and lines within the XML body) must terminate with CRLF (`\r\n`), per the manual. `Content-Length` must equal the exact byte length of the body.

### Transport implementation

Because Node/`axios` cannot emit an HTTP/1.0 request, `EagleClient` builds the request manually:

1. Open a `net.Socket` (plain TCP, no TLS) to `<host>:80`.
2. Write the request line `POST /cgi-bin/post_manager HTTP/1.0`, the headers (`Host`, `Content-type`, `Content-Length`, `Authorization: Basic …`), a blank line, then the XML body — all CRLF-terminated.
3. Accumulate all received bytes until the server closes the connection (HTTP/1.0 has no keep-alive by default).
4. Split off the status line + headers at the first blank line (`\r\n\r\n`); verify the status code; parse the remaining body as XML.
5. Enforce the configured timeout on the socket and ensure it is always destroyed (single in-flight request at a time).

### Response structure

The EAGLE responds with HTTP 200 and an XML fragment body. Element names are case-insensitive. Values are always ASCII text strings — numeric values must be parsed from the string.

---

## EagleClient — Commands & Data Flow

### Startup: device discovery

Send `device_list` to find the meter's hardware address:

```xml
<Command>
  <Name>device_list</Name>
</Command>
```

Response contains one `<Device>` per known device (HAN meter + any Control Network subdevices). Filter for `<ModelId>electric_meter</ModelId>` to find the utility meter:

```xml
<DeviceList>
  <Device>
    <HardwareAddress>0x0000000000000000</HardwareAddress>
    <Manufacturer>...</Manufacturer>
    <ModelId>electric_meter</ModelId>
    <Protocol>Zigbee</Protocol>
    <LastContact>0x5ab5bd9b</LastContact>
    <ConnectionStatus>Connected</ConnectionStatus>
    <NetworkAddress>0x0000</NetworkAddress>
  </Device>
</DeviceList>
```

Cache the `HardwareAddress` value **verbatim** in memory for all subsequent `device_query` calls. The value returned by `device_list` already includes the `0x` prefix (e.g. `0x000781000081fd0b`) — use it as-is. Do **not** re-prepend `0x`, or the request will contain a malformed `0x0x…` address.

### Poll command

On each poll cycle, send a targeted `device_query` requesting only the three variables needed:

```xml
<Command>
  <Name>device_query</Name>
  <DeviceDetails>
    <HardwareAddress>{meterAddress}</HardwareAddress>
  </DeviceDetails>
  <Components>
    <Component>
      <Name>Main</Name>
      <Variables>
        <Variable><Name>zigbee:InstantaneousDemand</Name></Variable>
        <Variable><Name>zigbee:CurrentSummationDelivered</Name></Variable>
        <Variable><Name>zigbee:CurrentSummationReceived</Name></Variable>
      </Variables>
    </Component>
  </Components>
</Command>
```

> **Note on `zigbee:CurrentSummationReceived`:** The documented `electric_meter` variable list (manual p.12–13) includes `InstantaneousDemand`, `Multiplier`, `Divisor`, `CurrentSummationDelivered`, `Price`, `RateLabel`, and `Message`, but does **not** list `CurrentSummationReceived`. Many meters/firmwares therefore will not return it. Request it best-effort: store the value if present, and silently ignore its absence (handled by the missing-variable fallback). Do not treat a missing export value as an error.

Response shape:

```xml
<Device>
  <DeviceDetails>
    <HardwareAddress>0x0000000000000000</HardwareAddress>
    <ConnectionStatus>Connected</ConnectionStatus>
    ...
  </DeviceDetails>
  <Components>
    <Component>
      <Name>Main</Name>
      <Variables>
        <Variable>
          <Name>zigbee:InstantaneousDemand</Name>
          <Value>1.234 kW</Value>
        </Variable>
        <Variable>
          <Name>zigbee:CurrentSummationDelivered</Name>
          <Value>12345.678 kWh</Value>
        </Variable>
        <Variable>
          <Name>zigbee:CurrentSummationReceived</Name>
          <Value>678.901 kWh</Value>
        </Variable>
      </Variables>
    </Component>
  </Components>
</Device>
```

### Optional: force a live refresh

The EAGLE buffers the last value received from the meter over ZigBee. To force it to actively request a fresh reading, add `<Refresh>Y</Refresh>` to a variable. Note: the refresh request itself returns no value — a second `device_query` (without refresh) is needed to read the updated value. This adds a round-trip delay and is **not recommended** for routine polling; the meter pushes updates every ~8 seconds automatically.

---

## Data Mapping

All `<Value>` fields are ASCII text strings with embedded units (e.g. `"21.499 kW"`, `"12345.678 kWh"` — confirmed in manual p.12). Parse by stripping the unit suffix and converting to float. The EAGLE has **already applied** the meter's `zigbee:Multiplier` / `zigbee:Divisor` scaling to produce the formatted string, so those variables do not need to be requested or applied by the plugin. Parse the unit token defensively (expect `kW`/`kWh`) so an unexpected unit can be logged rather than silently mis-scaled.

| ZigBee Variable | Meaning | Unit | HomeKit use |
|---|---|---|---|
| `zigbee:InstantaneousDemand` | Real-time grid demand | kW | Import accessory: `max(0, demand) × 1000` W. Export accessory: `max(0, −demand) × 1000` W. Each side shows non-negative watts; only one is non-zero at any given moment. |
| `zigbee:CurrentSummationDelivered` | Lifetime energy imported from grid | kWh | Import accessory: Eve kWh |
| `zigbee:CurrentSummationReceived` | Lifetime energy exported to grid | kWh | Export accessory (optional): Eve kWh. If meter does not return this variable, export kWh shows 0. |

**Sign convention**: `InstantaneousDemand` is documented as a non-negative value, but some meters/firmware return a negative value when the home is net-exporting power to the grid (e.g., solar production exceeds consumption). Both accessories clamp to non-negative watts using `max(0, ±demand × 1000)`, so they are mutually exclusive: when the home is importing, the import meter shows positive watts and the export meter shows zero, and vice versa. Net export accumulates in `SummationReceived` over time. The PVS6 plugin provides complementary solar production data.

**Documented meter variable list** (from `device_details`, manual p.12–13 — exact set varies by meter/firmware):

```
zigbee:InstantaneousDemand
zigbee:Multiplier
zigbee:Divisor
zigbee:CurrentSummationDelivered
zigbee:Price
zigbee:RateLabel
zigbee:Message
```

`zigbee:CurrentSummationReceived` is **not** in the documented list and may be unavailable on a given meter (see the note in the Poll command section). Use the live `device_details` command at runtime for diagnostics rather than assuming a fixed variable set.

---

## HomeKit Accessories

### Import Meter Accessory

Always registered. Shows real-time grid demand and lifetime energy imported.

**Accessory type:** Eve Energy  
**Custom HAP service UUID:** `E863F10A-079E-48FF-8F27-9C2605A29F52`  
**Display name (configurable):** `meterName` (default: `"Grid Meter - Import"` when `showExportMeter` is `true`; `"Grid Meter"` otherwise)  
**Platform accessory UUID:** `hap.uuid.generate(meterAddress)`

| Characteristic | HAP UUID | Source | Notes |
|---|---|---|---|
| `On` (read-only) | `00000025` | `InstantaneousDemand > 0` | Consuming = on. The HAP `On` characteristic is technically writable; the setter is a no-op that immediately reverts to the polled state. |
| `OutletInUse` | `00000026` | always `true` | Required by Eve Energy |
| Eve Watt | `E863F10D` | `max(0, InstantaneousDemand) × 1000` | Import watts. Zero when net-exporting. |
| Eve kWh | `E863F10C` | `CurrentSummationDelivered` | Lifetime import kWh |
| `Name` | `00000023` | config `meterName` | |

**fakegato history:** Records `{ time, power }` (W) at each successful poll.  
History service UUID: `E863F007-079E-48FF-8F27-9C2605A29F52`.  
Persisted to Homebridge storage directory; survives restarts.

**Apple Home tile:** Renders as a smart plug. `On` = actively consuming grid power. Wattage visible in detail view. Eve app shows up to 7 days of native consumption history.

---

### Export Meter Accessory (optional)

Registered only when `showExportMeter: true` in config. Shows real-time grid export and lifetime energy exported to the grid. Useful for households with solar net metering where export is reported via `CurrentSummationReceived`.

**Accessory type:** Eve Energy  
**Custom HAP service UUID:** `E863F10A-079E-48FF-8F27-9C2605A29F52`  
**Display name (configurable):** `exportMeterName` (default: `"Grid Meter - Export"`)  
**Platform accessory UUID:** `hap.uuid.generate(meterAddress + '-export')` — the `-export` suffix keeps it distinct from the import accessory UUID

| Characteristic | HAP UUID | Source | Notes |
|---|---|---|---|
| `On` (read-only) | `00000025` | `InstantaneousDemand < 0` | Exporting = on. No-op setter reverts to polled state. |
| `OutletInUse` | `00000026` | always `true` | Required by Eve Energy |
| Eve Watt | `E863F10D` | `max(0, −InstantaneousDemand) × 1000` | Export watts (positive). Zero when not exporting. |
| Eve kWh | `E863F10C` | `CurrentSummationReceived` | Lifetime export kWh. Shows `0` if meter does not report this variable. |
| `Name` | `00000023` | config `exportMeterName` | |

**fakegato history:** Records `{ time, power }` (W, export watts) at each successful poll.  
History service UUID: `E863F007-079E-48FF-8F27-9C2605A29F52`.  
Persisted to Homebridge storage directory; survives restarts.

**Apple Home tile:** Renders as a smart plug. `On` = actively exporting to grid. Eve app shows export history.

**When `CurrentSummationReceived` is absent:** If the meter does not return `zigbee:CurrentSummationReceived` (common — see note in Poll command section), the export kWh characteristic stays at `0`. Real-time export watts derived from negative `InstantaneousDemand` still works correctly. Log a debug message when the variable is missing rather than a warning (expected on many meters).

---

## Configuration

Configured via `config.json` in the Homebridge `platforms` array:

Minimal config (import only):

```json
{
  "platform": "EAGLE",
  "name": "EAGLE",
  "cloudId": "004792",
  "installCode": "bfb0fc05f51a3932"
}
```

With export meter enabled:

```json
{
  "platform": "EAGLE",
  "name": "EAGLE",
  "host": "192.168.1.x",
  "cloudId": "004792",
  "installCode": "bfb0fc05f51a3932",
  "pollInterval": 15,
  "meterName": "Grid Meter - Import",
  "showExportMeter": true,
  "exportMeterName": "Grid Meter - Export"
}
```

The device is also reachable via mDNS hostname `eagle-<cloudId>.local` if a static IP is not preferred.

### Config schema (`config.schema.json`)

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `host` | string | no | `eagle-<cloudId>.local` | IP address or mDNS hostname of EAGLE-200. Omit to use mDNS auto-discovery. |
| `cloudId` | string | yes | — | Cloud ID from device label (upper-left, 6 hex chars) |
| `installCode` | string | yes | — | Install Code from device label (16 hex chars) |
| `pollInterval` | integer | no | `15` | Seconds between polls. Minimum enforced: `5` |
| `meterName` | string | no | `"Grid Meter - Import"` if `showExportMeter` is `true`, otherwise `"Grid Meter"` | HomeKit display name for the import accessory |
| `showExportMeter` | boolean | no | `false` | Register a second Eve Energy accessory for grid export (net metering / solar). |
| `exportMeterName` | string | no | `"Grid Meter - Export"` | HomeKit display name for the export accessory. Only used when `showExportMeter` is `true`. |

---

## Session Management

The EAGLE-200 local API is **stateless** — no session cookie, no token exchange. Each POST is independently authenticated with Basic Auth credentials in the header. `EagleClient` includes credentials on every request; there is no login/logout lifecycle.

**Meter address caching:** Performed once at startup via `device_list`. Stored in memory for the process lifetime. A Homebridge restart re-discovers the address, which handles any edge case where it changes.

---

## Error Handling

| Condition | Behaviour |
|---|---|
| EAGLE unreachable at startup | Log error, retry `device_list` every 30s |
| `device_list` returns no `electric_meter` device | Log warning, retry every 60s |
| Meter `ConnectionStatus` is not `Connected` | Log warning, skip poll cycle |
| Poll timeout (>10s) | Skip cycle, log warning, retain last values |
| XML parse failure / truncated body | Log warning with raw response body, treat as skipped cycle, retain last values |
| Missing variable in poll response | Use last known good value, log debug |
| HTTP 401 | Log error (wrong credentials); back off 60s, do not retry immediately |
| HTTP 503 / other 5xx | Device HTTP server overloaded. Skip cycle, log warning, and apply a short backoff (e.g. temporarily widen the poll interval) to avoid hammering the device |
| `pollInterval` < 5 in config | Clamp to 5, log warning |

> **Overload caution:** The EAGLE's embedded HTTP server is easily overwhelmed by frequent polling and will respond with `503` errors or truncated/unparseable XML. Treat these as transient skipped cycles (not fatal), back off rather than retrying immediately, and keep the default `pollInterval` conservative. A single in-flight request at a time should be enforced (no overlapping polls).

Accessories remain visible in HomeKit during outages; characteristic values freeze at last known good until connectivity resumes.

---

## Key Differences from homebridge-pvs6

| Aspect | homebridge-pvs6 | homebridge-eagle |
|---|---|---|
| Protocol | HTTPS (self-signed cert) | HTTP plain |
| Auth | Session cookie; re-auth on 401 | Stateless Basic Auth per request |
| Data format | JSON (varserver key/value) | XML fragments |
| Startup | Build varserver cache IDs | Discover meter `HardwareAddress` |
| Value format | Native float in JSON | ASCII string with unit suffix |
| Accessories | Solar + Grid (each optional) | Grid import (always) + Grid export (optional, `showExportMeter`) |
| Negative power | `net_p` goes negative on export | Raw `InstantaneousDemand` may go negative; split across import/export accessories via `max(0, ±demand)` |

---

## fakegato Integration

Uses [`fakegato-history`](https://github.com/simont77/fakegato-history) npm package.

- History type: `energy`
- Data logged: `{ time, power }` in Watts at each successful poll
- Persisted to Homebridge storage directory
- Eve app renders up to 7 days of native consumption history natively

---

## File Structure

```
homebridge-eagle/
├── src/
│   ├── index.ts                  — Homebridge platform registration
│   ├── platform.ts               — EAGLEPlatform class, accessory lifecycle
│   ├── eagleClient.ts            — HTTP POST, XML parsing, device discovery, polling
│   ├── gridMeterAccessory.ts     — Import meter HomeKit accessory + fakegato
│   ├── exportMeterAccessory.ts   — Export meter HomeKit accessory + fakegato (optional)
│   └── eveCharacteristics.ts    — Eve custom UUID definitions
├── config.schema.json
├── package.json
├── tsconfig.json
└── README.md
```

---

## Dependencies

| Package | Purpose |
|---|---|
| `homebridge` | Peer dependency |
| `fakegato-history` | Eve history storage and HAP service |
| `fast-xml-parser` | XML response parsing. Responses arrive as a single rooted element (`<Device>`, `<DeviceList>`), so they parse directly — no synthetic root wrapper is needed. Request bodies are sent as raw XML fragments. |

The HTTP/1.0 transport is built on Node's core `net` module (raw TCP socket); no third-party HTTP client (`axios`/`node-fetch`) is required. Basic Auth is added by Base64-encoding `"<CloudID>:<InstallCode>"` into the `Authorization` header manually.

Node.js ≥ 18 required.

---

## Shared Code Opportunity

`eveCharacteristics.ts` is identical between `homebridge-pvs6` and `homebridge-eagle`. If both plugins are maintained in the same repository or as a monorepo, this file can be shared. For standalone npm distribution, duplicating the small file keeps each plugin self-contained and dependency-free between them.

---

## Out of Scope (v1)

- Utility price / tariff data (`zigbee:Price`, `zigbee:PriceTier`)
- Utility push messages (`zigbee:Message`, `confirm_message`)
- Fast-poll mode (`set_fast_poll` ZigBee SEP 1.1 command)
- Cloud / relay-server API (rainforestcloud.com)
- Control Network subdevices (smart plugs, thermostats, load switches)
- Original EAGLE Z109

---

## Future Considerations

- A derived `Net Power` value combining EAGLE demand with PVS6 production — could live in a separate aggregator platform plugin
- Prometheus metrics sidecar endpoint (consistent pattern with homebridge-pvs6)
- `device_details` diagnostic command exposed via a Homebridge UI button for troubleshooting

---

## Implementation Learnings — Homebridge / Eve Energy Plugin

Lessons discovered while building this plugin. Recorded here so they transfer directly to the next HomeKit Eve plugin without repeating the same debugging cycles.

### Custom Eve Service: find by UUID, not `getService()`

`accessory.getService(string)` in hap-nodejs matches by `displayName`, `name`, or `subtype` — **not** by UUID. After a Homebridge restart the cached accessory's Eve service will not be found, and a duplicate service will be added, causing errors. The correct pattern:

```typescript
const existingService = accessory.services.find(s => s.UUID === EVE_ENERGY_SERVICE_UUID);
if (existingService) {
  this.eveEnergyService = existingService;
} else {
  this.eveEnergyService = accessory.addService(
    new api.hap.Service(displayName, EVE_ENERGY_SERVICE_UUID),
  );
}
```

### Custom Eve Characteristics: `getCharacteristic()` not `addCharacteristic()`

`addCharacteristic()` **always** adds a new instance and throws `DuplicateCharacteristicError` on the second Homebridge start (because the characteristic already exists in the cached service). Use `getCharacteristic(CharClass)` instead — it returns the existing instance from cache, or adds it if it is genuinely absent:

```typescript
// Correct — idempotent across restarts
this.eveEnergyService.getCharacteristic(EveWatts).onGet(() => this.lastDemandW);

// Wrong — throws on restart
this.eveEnergyService.addCharacteristic(EveWatts).onGet(() => this.lastDemandW);
```

### Eve Energy Service Instantiation

The Eve Energy service UUID (`E863F10A-079E-48FF-8F27-9C2605A29F52`) is not in the standard HAP service registry. Instantiate it directly:

```typescript
new api.hap.Service(displayName, EVE_ENERGY_SERVICE_UUID)
```

Do **not** use a built-in service type like `Service.Outlet` — the Eve app won't recognise it without the correct UUID.

### `OutletInUse` Is Required

The Eve Energy accessory model requires the `OutletInUse` characteristic (`00000026`). Omitting it can cause the accessory to render incorrectly in the Eve app. Wire it to always return `true`:

```typescript
this.eveEnergyService.getCharacteristic(Characteristic.OutletInUse).onGet(() => true);
```

### The `On` Characteristic Must Have a No-op Setter

HAP's `On` characteristic (`00000025`) is defined as read/write. Without a setter, hap-nodejs logs a warning. With a writable setter that does nothing, HomeKit can toggle the tile momentarily. The correct pattern is to immediately revert to the polled state:

```typescript
this.eveEnergyService
  .getCharacteristic(Characteristic.On)
  .onGet(() => this.lastDemandW > 0)
  .onSet(async () => {
    this.eveEnergyService.updateCharacteristic(Characteristic.On, this.lastDemandW > 0);
  });
```

### TypeScript Pattern for Custom Characteristic Classes

hap-nodejs expects characteristic constructors typed as `{ new(): Characteristic; UUID: string }`. The inner class inheriting from `hap.Characteristic` does not satisfy this constraint without a cast:

```typescript
export type EveCharClass = { new(): Characteristic; UUID: string };

return {
  EveWatts: EveWatts as unknown as EveCharClass,
  EveKWh:   EveKWh   as unknown as EveCharClass,
};
```

Use `as unknown as EveCharClass` — a direct cast fails TypeScript's strict checks.

### Custom Unit Strings in Characteristics

HAP's `unit` property is typed as a `Units` enum, which does not include `'W'` or `'kWh'`. Cast to `string` to use non-standard unit labels:

```typescript
unit: 'W' as string,
```

### Stable Accessory UUID from Hardware Identity

Generate the platform accessory UUID from a stable hardware identifier (e.g., the meter's hardware address) so that cached accessories survive Homebridge restarts without being re-registered:

```typescript
const uuid = this.api.hap.uuid.generate(meterAddress);
```

Using the config `name` or a hardcoded string breaks caching when the name changes or when multiple instances of the plugin run.

### Serial Number: Strip `0x` Prefix

Hardware addresses returned by device APIs include a `0x` hex prefix. Strip it for the HomeKit `SerialNumber` characteristic — HomeKit displays it directly to the user:

```typescript
infoService.setCharacteristic(Characteristic.SerialNumber, meterAddress.replace(/^0x/i, ''));
```

### fakegato-history: Load After `didFinishLaunching`

`fakegato-history` must be loaded via `require()` (not `import`) and called **after** the Homebridge `api` object is fully initialised — i.e., inside the `didFinishLaunching` callback, not in the platform constructor:

```typescript
// Inside registerOrRestoreAccessory(), called from didFinishLaunching handler:
const FakeGatoHistoryService = require('fakegato-history')(this.api);
this.historyService = new FakeGatoHistoryService('energy', accessory, { storage: 'fs' });
```

Passing `{ storage: 'fs' }` is required for history to persist across restarts; without it, history is in-memory only.

### fakegato `addEntry` Format for `energy` Type

The energy history type expects `{ time, power }` with:
- `time`: Unix timestamp in **seconds** (not milliseconds) — `Math.round(Date.now() / 1000)`
- `power`: Watts (not kW)

```typescript
this.historyService.addEntry({
  time: Math.round(Date.now() / 1000),
  power: this.lastDemandW,   // already in Watts
});
```

### `fast-xml-parser`: Force Arrays and Disable Tag-value Coercion

Two parser options are critical for reliable XML parsing:

1. **`parseTagValue: false`** — prevents automatic coercion of numeric strings to `number`. Keeps all values as strings so they can be parsed consistently by application code.

2. **`isArray` callback** — without it, a response containing a single `<Device>` or `<Variable>` element is parsed as an object (not an array), breaking `Array.isArray()` checks. Declare which element names are always arrays:

```typescript
new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  isArray: (name, jpath) =>
    (name === 'Device' && jpath === 'DeviceList.Device') || name === 'Variable',
});
```

The `jpath` guard on `Device` is important: the `device_list` response wraps devices in `<DeviceList>` (array context), but the `device_query` response returns a single `<Device>` at the root — that one must **not** be forced into an array.

### `pollInFlight` Guard for Overlapping Polls

`setInterval` fires regardless of whether the previous async operation has completed. On a slow or unresponsive device this causes overlapping requests, which can overwhelm an embedded HTTP server. Guard with a boolean flag:

```typescript
if (this.pollInFlight) return;
this.pollInFlight = true;
try {
  await this.client.queryMeter(address);
} finally {
  this.pollInFlight = false;
}
```

### `displayName` in `package.json` for Homebridge Plugin Registry

The Homebridge plugin registry UI uses the `"displayName"` field in `package.json` (distinct from `"name"`) as the human-readable label shown in the UI. Without it, the raw npm package name is shown:

```json
{
  "name": "homebridge-rainforest-eagle3-abirismyname",
  "displayName": "Eagle 3",
  ...
}
```
