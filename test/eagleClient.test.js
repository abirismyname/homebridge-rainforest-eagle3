const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const { once } = require('node:events');
const { test } = require('node:test');
const { EagleClient, HttpError } = require('../dist/eagleClient');

const discoveryXml = '<DeviceList><Device><ModelId>electric_meter</ModelId>' +
  '<HardwareAddress>0x1234</HardwareAddress></Device></DeviceList>';
const readingXml = '<Device><DeviceDetails><ConnectionStatus>Connected</ConnectionStatus>' +
  '</DeviceDetails><Components><Component><Variables>' +
  '<Variable><Name>zigbee:InstantaneousDemand</Name><Value>1.5 kW</Value></Variable>' +
  '<Variable><Name>zigbee:CurrentSummationDelivered</Name><Value>42 kWh</Value></Variable>' +
  '</Variables></Component></Components></Device>';
const log = { debug() {}, warn() {} };

async function fixture(t, respond) {
  const requests = [];
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      const split = data.indexOf('\r\n\r\n');
      if (split < 0) {
        return;
      }
      const length = Number(data.slice(0, split).match(/Content-Length: (\d+)/i)?.[1]);
      if (Buffer.byteLength(data.slice(split + 4)) < length) {
        return;
      }
      requests.push(data);
      socket.end(respond(data, requests.length));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const host = `127.0.0.1:${server.address().port}`;
  return {
    client: new EagleClient(host, 'test-id', 'test-code', log),
    requests,
    host,
  };
}

function ok(body = discoveryXml) {
  return `HTTP/1.0 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

test('301 preserves HTTP/1.0, POST, XML, and authentication; polling reuses the endpoint', async (t) => {
  const { client, requests } = await fixture(t, (request, count) => {
    if (count === 1) {
      return 'HTTP/1.0 301 Moved Permanently\r\nlOcAtIoN: /new/api?meter=1\r\n\r\n';
    }
    return ok(count === 2 ? discoveryXml : readingXml);
  });

  assert.equal(await client.discoverMeter(), '0x1234');
  assert.deepEqual(await client.queryMeter('0x1234'), {
    demand_kw: 1.5,
    summation_delivered_kwh: 42,
    summation_received_kwh: undefined,
  });
  assert.equal(requests.length, 3);
  assert.match(requests[0], /^POST \/cgi-bin\/post_manager HTTP\/1\.0\r\n/);
  for (const request of requests.slice(1)) {
    assert.match(request, /^POST \/new\/api\?meter=1 HTTP\/1\.0\r\n/);
    assert.match(request, /Authorization: Basic dGVzdC1pZDp0ZXN0LWNvZGU=\r\n/);
  }
  assert.equal(requests[0].split('\r\n\r\n')[1], requests[1].split('\r\n\r\n')[1]);
  assert.match(requests[2], /<Name>device_query<\/Name>/);
});

test('follows relative and absolute redirects with updated ports and Host headers', async (t) => {
  const target = await fixture(t, () => ok());
  const source = await fixture(t, (request, count) => count === 1
    ? 'HTTP/1.0 302 Found\r\nLocation: next\r\n\r\n'
    : `HTTP/1.0 308 Permanent Redirect\r\nLocation: http://${target.host}/final\r\n\r\n`);

  assert.equal(await source.client.discoverMeter(), '0x1234');
  assert.match(source.requests[1], /^POST \/cgi-bin\/next HTTP\/1\.0/);
  assert.match(target.requests[0], /^POST \/final HTTP\/1\.0/);
  assert.ok(target.requests[0].includes(`Host: ${target.host}\r\n`));
});

test('HTTPS upgrades use TLS and preserve HTTP/1.0', async (t) => {
  const target = await fixture(t, () => ok());
  const source = await fixture(t, () =>
    `HTTP/1.0 301 Moved Permanently\r\nLocation: https://${target.host}/secure\r\n\r\n`);
  let options;
  t.mock.method(tls, 'connect', (connectionOptions) => {
    options = connectionOptions;
    const socket = net.connect(connectionOptions);
    socket.once('connect', () => socket.emit('secureConnect'));
    return socket;
  });

  assert.equal(await source.client.discoverMeter(), '0x1234');
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, Number(target.host.split(':')[1]));
  assert.notEqual(options.rejectUnauthorized, false);
  assert.match(target.requests[0], /^POST \/secure HTTP\/1\.0/);
});

test('redirect loops stop after five redirects', async (t) => {
  const { client, requests } = await fixture(t, () =>
    'HTTP/1.0 301 Moved Permanently\r\nLocation: /loop\r\n\r\n');
  await assert.rejects(client.discoverMeter(), /Too many HTTP redirects/);
  assert.equal(requests.length, 6);
});

for (const [location, error] of [
  ['http://localhost/new', /another host/],
  ['http://test-user@127.0.0.1/new', /containing credentials/],
  ['ftp://127.0.0.1/new', /Unsupported HTTP redirect protocol/],
  ['http://[invalid', /Invalid URL/],
]) {
  test(`rejects unsafe or invalid redirect: ${location}`, async (t) => {
    const { client, requests } = await fixture(t, () =>
      `HTTP/1.0 301 Moved Permanently\r\nLocation: ${location}\r\n\r\n`);
    await assert.rejects(client.discoverMeter(), error);
    assert.equal(requests.length, 1);
  });
}

test('HTTPS redirects cannot downgrade to HTTP', async (t) => {
  const target = await fixture(t, () =>
    'HTTP/1.0 307 Temporary Redirect\r\nLocation: http://127.0.0.1/insecure\r\n\r\n');
  const source = await fixture(t, () =>
    `HTTP/1.0 301 Moved Permanently\r\nLocation: https://${target.host}/secure\r\n\r\n`);
  t.mock.method(tls, 'connect', (options) => {
    const socket = net.connect(options);
    socket.once('connect', () => socket.emit('secureConnect'));
    return socket;
  });
  await assert.rejects(source.client.discoverMeter(), /insecure HTTP/);
  assert.equal(target.requests.length, 1);
});

test('redirects without Location retain the HTTP status', async (t) => {
  const { client } = await fixture(t, () => 'HTTP/1.0 301 Moved Permanently\r\n\r\n');
  await assert.rejects(client.discoverMeter(), (error) =>
    error instanceof HttpError && error.statusCode === 301 && /Location/.test(error.message));
});

for (const status of [401, 503]) {
  test(`HTTP ${status} errors retain their status`, async (t) => {
    const { client } = await fixture(t, () => `HTTP/1.0 ${status} Error\r\n\r\n`);
    await assert.rejects(client.discoverMeter(), (error) =>
      error instanceof HttpError && error.statusCode === status);
  });
}

test('empty successful responses still fail', async (t) => {
  const { client } = await fixture(t, () => ok(''));
  await assert.rejects(client.discoverMeter(), /Empty response body/);
});

test('malformed responses still fail', async (t) => {
  const { client } = await fixture(t, () => 'not HTTP');
  await assert.rejects(client.discoverMeter(), /Malformed HTTP response/);
});
