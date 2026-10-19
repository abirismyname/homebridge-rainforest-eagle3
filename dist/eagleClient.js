"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.EagleClient = exports.HttpError = void 0;
const net = __importStar(require("net"));
const tls = __importStar(require("tls"));
const fast_xml_parser_1 = require("fast-xml-parser");
// Thrown for HTTP-level errors so the caller can distinguish 401 vs 503 vs other.
class HttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'HttpError';
    }
}
exports.HttpError = HttpError;
class EagleClient {
    constructor(host, cloudId, installCode, log) {
        this.log = log;
        this.auth = Buffer.from(`${cloudId}:${installCode}`).toString('base64');
        this.endpoint = new URL(`http://${host}/cgi-bin/post_manager`);
        this.parser = new fast_xml_parser_1.XMLParser({
            ignoreAttributes: false,
            parseTagValue: false,
            // Force Device to array only inside DeviceList (device_list response).
            // The device_query response has a single <Device> at root — must NOT be an array.
            isArray: (name, jpath) => (name === 'Device' && jpath === 'DeviceList.Device') || name === 'Variable',
        });
    }
    // Returns the HardwareAddress of the electric_meter device.
    async discoverMeter() {
        const body = '<Command>\r\n  <Name>device_list</Name>\r\n</Command>';
        const responseXml = await this.sendCommand(body);
        const parsed = this.parser.parse(responseXml);
        const deviceList = parsed['DeviceList'];
        if (!deviceList) {
            throw new Error('device_list response missing <DeviceList> element');
        }
        const devices = deviceList['Device'];
        if (!Array.isArray(devices) || devices.length === 0) {
            throw new Error('No devices in device_list response');
        }
        const meter = devices.find((d) => String(d['ModelId'] ?? '').toLowerCase() === 'electric_meter');
        if (!meter) {
            throw new Error('No electric_meter device found in device_list response');
        }
        const address = meter['HardwareAddress'];
        if (!address) {
            throw new Error('electric_meter device has no HardwareAddress');
        }
        // The EAGLE returns the address with the 0x prefix already — use verbatim.
        return String(address);
    }
    // Returns current meter readings. summation_received_kwh is optional — not all
    // meters/firmwares return CurrentSummationReceived.
    async queryMeter(meterAddress) {
        const body = [
            '<Command>',
            '  <Name>device_query</Name>',
            '  <DeviceDetails>',
            `    <HardwareAddress>${meterAddress}</HardwareAddress>`,
            '  </DeviceDetails>',
            '  <Components>',
            '    <Component>',
            '      <Name>Main</Name>',
            '      <Variables>',
            '        <Variable><Name>zigbee:InstantaneousDemand</Name></Variable>',
            '        <Variable><Name>zigbee:CurrentSummationDelivered</Name></Variable>',
            '        <Variable><Name>zigbee:CurrentSummationReceived</Name></Variable>',
            '      </Variables>',
            '    </Component>',
            '  </Components>',
            '</Command>',
        ].join('\r\n');
        const responseXml = await this.sendCommand(body);
        const parsed = this.parser.parse(responseXml);
        const device = parsed['Device'];
        if (!device) {
            throw new Error('device_query response missing <Device> element');
        }
        const deviceDetails = device['DeviceDetails'];
        const connectionStatus = deviceDetails?.['ConnectionStatus'] ?? '';
        if (connectionStatus.toLowerCase() !== 'connected') {
            throw new Error(`Meter ConnectionStatus is '${connectionStatus}', not Connected`);
        }
        // Navigate Device > Components > Component > Variables > Variable[]
        const components = device['Components'];
        const component = components?.['Component'];
        const variables = component?.['Variables'];
        const varList = variables?.['Variable'];
        if (!Array.isArray(varList)) {
            throw new Error('device_query response has no <Variable> elements');
        }
        const varMap = new Map();
        for (const v of varList) {
            const name = v['Name'];
            const value = v['Value'];
            if (name && value) {
                varMap.set(String(name), String(value));
            }
        }
        const demand_kw = this.parseValue(varMap.get('zigbee:InstantaneousDemand'), 'zigbee:InstantaneousDemand');
        const summation_delivered_kwh = this.parseValue(varMap.get('zigbee:CurrentSummationDelivered'), 'zigbee:CurrentSummationDelivered');
        const receivedRaw = varMap.get('zigbee:CurrentSummationReceived');
        const summation_received_kwh = receivedRaw !== undefined
            ? this.parseValue(receivedRaw, 'zigbee:CurrentSummationReceived')
            : undefined;
        return { demand_kw, summation_delivered_kwh, summation_received_kwh };
    }
    async sendCommand(xmlBody) {
        let endpoint = this.endpoint;
        for (let redirects = 0;; redirects++) {
            const response = await this.sendRequest(xmlBody, endpoint);
            if (response.location === undefined) {
                this.endpoint = endpoint;
                return response.body;
            }
            if (redirects >= 5) {
                throw new Error('Too many HTTP redirects (maximum 5)');
            }
            const next = new URL(response.location, endpoint);
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                throw new Error('Unsupported HTTP redirect protocol');
            }
            if (next.hostname !== endpoint.hostname || next.username || next.password) {
                throw new Error('Refusing HTTP redirect to another host or a URL containing credentials');
            }
            if (endpoint.protocol === 'https:' && next.protocol !== 'https:') {
                throw new Error('Refusing HTTPS redirect to insecure HTTP');
            }
            endpoint = next;
        }
    }
    // Raw HTTP/1.0 over TCP/TLS — axios/fetch cannot downgrade from HTTP/1.1.
    sendRequest(xmlBody, endpoint) {
        return new Promise((resolve, reject) => {
            const bodyBytes = Buffer.from(xmlBody, 'utf8');
            const request = `POST ${endpoint.pathname}${endpoint.search} HTTP/1.0\r\n` +
                `Host: ${endpoint.host}\r\n` +
                `Content-type: text/xml\r\n` +
                `Content-Length: ${bodyBytes.length}\r\n` +
                `Authorization: Basic ${this.auth}\r\n` +
                `\r\n`;
            const secure = endpoint.protocol === 'https:';
            const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
            const options = {
                host: hostname,
                port: Number(endpoint.port || (secure ? 443 : 80)),
            };
            const socket = secure
                ? tls.connect({
                    ...options,
                    servername: net.isIP(hostname) ? undefined : hostname,
                })
                : net.connect(options);
            const chunks = [];
            let settled = false;
            const done = (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                if (err) {
                    reject(err);
                }
            };
            socket.setTimeout(10000);
            socket.on('timeout', () => done(new Error('Socket timeout after 10s')));
            socket.on('error', (err) => done(err));
            socket.on('data', (chunk) => chunks.push(chunk));
            socket.on('close', () => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                const raw = Buffer.concat(chunks).toString('utf8');
                const headerBodySplit = raw.indexOf('\r\n\r\n');
                if (headerBodySplit === -1) {
                    reject(new Error('Malformed HTTP response: no header/body separator'));
                    return;
                }
                const headerSection = raw.slice(0, headerBodySplit);
                const body = raw.slice(headerBodySplit + 4);
                this.log.debug(`EAGLE response: ${body.trim()}`);
                const statusLine = headerSection.split('\r\n')[0] ?? '';
                const statusMatch = statusLine.match(/^HTTP\/\S+\s+(\d{3})/);
                if (!statusMatch) {
                    reject(new Error(`Could not parse HTTP status line: ${statusLine}`));
                    return;
                }
                const statusCode = parseInt(statusMatch[1], 10);
                if ([301, 302, 307, 308].includes(statusCode)) {
                    const location = headerSection.split('\r\n').slice(1)
                        .find((line) => /^location:/i.test(line))?.slice('location:'.length).trim();
                    if (!location) {
                        reject(new HttpError(statusCode, `HTTP ${statusCode}: missing Location header`));
                        return;
                    }
                    resolve({ body, location });
                    return;
                }
                if (statusCode !== 200) {
                    reject(new HttpError(statusCode, `HTTP ${statusCode}: ${statusLine}`));
                    return;
                }
                if (!body.trim()) {
                    reject(new Error('Empty response body'));
                    return;
                }
                resolve({ body });
            });
            socket.once(secure ? 'secureConnect' : 'connect', () => {
                socket.write(request);
                socket.write(bodyBytes);
            });
        });
    }
    parseValue(raw, varName) {
        if (raw === undefined) {
            throw new Error(`Required variable ${varName} missing from response`);
        }
        const trimmed = raw.trim();
        // Expected format: "1.234 kW" or "12345.678 kWh"
        const match = trimmed.match(/^(-?[\d.]+)\s*(\S+)?$/);
        if (!match) {
            throw new Error(`Cannot parse value '${trimmed}' for ${varName}`);
        }
        const unit = match[2] ?? '';
        if (unit && unit !== 'kW' && unit !== 'kWh') {
            this.log.warn(`Unexpected unit '${unit}' for ${varName} — value: ${trimmed}`);
        }
        const parsed = parseFloat(match[1]);
        if (isNaN(parsed)) {
            throw new Error(`NaN after parsing '${trimmed}' for ${varName}`);
        }
        return parsed;
    }
}
exports.EagleClient = EagleClient;
//# sourceMappingURL=eagleClient.js.map