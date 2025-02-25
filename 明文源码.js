import { connect } from 'cloudflare:sockets';

let isDebug = false;
let userID = '1f0aa99f-b129-454c-b71e-8e5722da4a8d';

let proxyIP = '';
let socks5Address = '';
let parsedSocks5Address = {};
let enableSocks = false;

if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			isDebug = env.DEBUG || isDebug;
			userID = env.UUID || userID;
			const upgradeHeader = request.headers.get('Upgrade');
			const url = new URL(request.url);
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				switch (url.pathname) {
					case '/':
						return new Response(JSON.stringify(request.cf), { status: 200 });
					case `/${userID}`: {
						const slvPage = getSLVHomePage(userID, request.headers.get('Host'));
						return new Response(`${slvPage}`, {
							status: 200,
							headers: {
								"Content-Type": "text/plain;charset=utf-8",
							}
						});
					}
					default:
						return new Response('Not found', { status: 404 });
				}
			} else {

				proxyIP = env.PROXYIP || proxyIP;
				const proxyIPs = await splitArray(proxyIP);
				proxyIP = proxyIPs.length ? proxyIPs[Math.floor(Math.random() * proxyIPs.length)] : proxyIP;

				socks5Address = env.SOCKS5 || socks5Address;
				const socks5s = await splitArray(socks5Address);
				socks5Address = socks5s.length ? socks5s[Math.floor(Math.random() * socks5s.length)] : socks5Address;
				socks5Address = socks5Address.split('//')[1] || socks5Address;

				socks5Address = url.searchParams.get('socks5') || socks5Address;
				if (new RegExp('/socks5=', 'i').test(url.pathname)) socks5Address = url.pathname.split('5=')[1];
				else if (new RegExp('/socks://', 'i').test(url.pathname) || new RegExp('/socks5://', 'i').test(url.pathname)) {
					socks5Address = url.pathname.split('://')[1].split('#')[0];
					if (socks5Address.includes('@')) {
						let userPassword = socks5Address.split('@')[0];
						const base64Regex = /^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i;
						if (base64Regex.test(userPassword) && !userPassword.includes(':')) userPassword = atob(userPassword);
						socks5Address = `${userPassword}@${socks5Address.split('@')[1]}`;
					}
				}

				if (socks5Address) {
					try {
						parsedSocks5Address = socks5AddrSplit(socks5Address);
						enableSocks = true;
					} catch (err) {
						let e = err;
						if (isDebug) console.log(e.toString());
						enableSocks = false;
					}
				} else {
					enableSocks = false;
				}

				if (url.searchParams.has('proxyip')) {
					proxyIP = url.searchParams.get('proxyip');
					enableSocks = false;
				} else if (new RegExp('/proxyip=', 'i').test(url.pathname)) {
					proxyIP = url.pathname.toLowerCase().split('/proxyip=')[1];
					enableSocks = false;
				} else if (new RegExp('/pyip=', 'i').test(url.pathname)) {
					proxyIP = url.pathname.toLowerCase().split('/pyip=')[1];
					enableSocks = false;
				}

				return await WSRequestHandler(request);
			}
		} catch (err) {
			/** @type {Error} */ let e = err;
			return new Response(e.toString());
		}
	},
};


/**
 * 
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function WSRequestHandler(request) {

	/** @type {import("@cloudflare/workers-types").WebSocket[]} */
	// @ts-ignore
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (/** @type {string} */ info, /** @type {string | undefined} */ event) => {
		if (isDebug) console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	/** @type {{ value: import("@cloudflare/workers-types").Socket | null}}*/
	let remoteSocketWapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDns = false;

	// ws --> remote
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns && udpStreamWrite) {
				return udpStreamWrite(chunk);
			}
			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter()
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			const {
				hasError,
				message,
				addressType,
				portRemote = 443,
				addressRemote = '',
				rawDataIndex,
				slvVersion = new Uint8Array([0, 0]),
				isUDP,
			} = processSlvHeader(chunk, userID);
			address = addressRemote;
			portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '} `;
			if (hasError) {
				throw new Error(message); // cf seems has bug, controller.error will not end stream
				return;
			}
			// if UDP but port not DNS port, close it
			if (isUDP) {
				if (portRemote === 53) {
					isDns = true;
				} else {
					throw new Error('UDP proxy only enable for DNS which is port 53'); // cf seems has bug, controller.error will not end stream
					return;
				}
			}

			const slvResponseHeader = new Uint8Array([slvVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			// TODO: support udp here when cf runtime has udp support
			if (isDns) {
				const { write } = await handleUDPOutBound(webSocket, slvResponseHeader, log);
				udpStreamWrite = write;
				udpStreamWrite(rawClientData);
				return;
			}
			handleTCPOutBound(remoteSocketWapper, addressType, addressRemote, portRemote, rawClientData, webSocket, slvResponseHeader, log);
		},
		close() {
			log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			log(`readableWebSocketStream is abort`, JSON.stringify(reason));
		},
	})).catch((err) => {
		log('readableWebSocketStream pipeTo error', err);
	});

	return new Response(null, {
		status: 101,
		// @ts-ignore
		webSocket: client,
	});
}

async function splitArray(content) {
	let rep_text = content.replace(/[\t"'\r\n]+/g, ',').replace(/,+/g, ',');
	if (rep_text.charAt(0) == ',') rep_text = rep_text.slice(1);
	if (rep_text.charAt(rep_text.length - 1) == ',') rep_text = rep_text.slice(0, rep_text.length - 1);

	const res_array = rep_text.split(',');

	return res_array;
}

function socks5AddrSplit(address) {
	let [latter, former] = address.split("@").reverse();
	let username, password, hostname, port;

	if (former) {
		const formers = former.split(":");
		if (formers.length !== 2) {
			throw new Error('Invalid SOCKS format： requirements include "username:password"');
		}
		[username, password] = formers;
	}

	const latters = latter.split(":");
	port = Number(latters.pop());
	if (isNaN(port)) {
		throw new Error('Invalid SOCKS format：port number must be a number');
	}

	hostname = latters.join(":");

	const regex = /^\[.*\]$/;
	if (hostname.includes(":") && !regex.test(hostname)) {
		throw new Error('Invalid SOCKS format：IPv6 error');
	}

	return {
		username,
		password,
		hostname,
		port,
	}
}

async function socks5Connect(addressType, addressRemote, portRemote, log) {
	const { username, password, hostname, port } = parsedSocks5Address;
	const socket = connect({
		hostname,
		port,
	});

	const socksGreeting = new Uint8Array([5, 2, 0, 2]);

	const writer = socket.writable.getWriter();

	await writer.write(socksGreeting);
	log('send SOCKS5 hello');

	const reader = socket.readable.getReader();
	const encoder = new TextEncoder();
	let res = (await reader.read()).value;
	if (!res) {
		log('SOCKS5 response is empty');
		return;
	}

	if (res[0] !== 0x05) {
		log(`SOCKS5 version error: recv ${res[0]}，expect is 5`);
		return;
	}

	if (res[1] === 0xff) {
		log("The server does not accept any authentication methods");
		return;
	}

	if (res[1] === 0x02) {
		log("SOCKS5 server requires authentication");
		if (!username || !password) {
			log("Please provide your username and password");
			return;
		}

		const authRequest = new Uint8Array([
			1,
			username.length,
			...encoder.encode(username),
			password.length,
			...encoder.encode(password)
		]);
		await writer.write(authRequest);
		res = (await reader.read()).value;
		if (res[0] !== 0x01 || res[1] !== 0x00) {
			log("SOCKS5 server authentication failed");
			return;
		}
	}


	let DSTADDR;
	switch (addressType) {
		case 1: // IPv4
			DSTADDR = new Uint8Array(
				[1, ...addressRemote.split('.').map(Number)]
			);
			break;
		case 2: // Domain
			DSTADDR = new Uint8Array(
				[3, addressRemote.length, ...encoder.encode(addressRemote)]
			);
			break;
		case 3: // IPv6
			DSTADDR = new Uint8Array(
				[4, ...addressRemote.split(':').flatMap(x => [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)])]
			);
			break;
		default:
			log(`Invalid IP address type: ${addressType}`);
			return;
	}

	const socksRequest = new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]);
	await writer.write(socksRequest);
	log('SOCKS5 request sent');

	res = (await reader.read()).value;
	if (res && res[1] === 0x00) {
		log("SOCKS5 connection established");
	} else {
		log("SOCKS5 connection failed");
		return;
	}

	writer.releaseLock();
	reader.releaseLock();
	return socket;
}

/**
 * Handles outbound TCP connections.
 *
 * @param {any} remoteSocket 
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} slvResponseHeader The slv response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressType, addressRemote, portRemote, rawClientData, webSocket, slvResponseHeader, log) {
	async function connectAndWrite(address, port, socks = false) {
		/** @type {import("@cloudflare/workers-types").Socket} */
		log(`connected to ${address}:${port}`);
		const tcpSocket = socks ? await socks5Connect(addressType, address, port, log)
			: connect({
				hostname: address,
				port: port,
			});
		remoteSocket.value = tcpSocket;
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData); // first write, nomal is tls client hello
		writer.releaseLock();
		return tcpSocket;
	}

	// if the cf connect tcp socket have no incoming data, we retry to redirect ip
	async function retry() {
		let tcpSocket;
		if (enableSocks) {
			// SOCKS5
			tcpSocket = await connectAndWrite(addressRemote, portRemote, true);
		} else {
			tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
		}

		// no matter retry success or not, close websocket
		tcpSocket.closed.catch(error => {
			if (isDebug) console.log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})

		remoteSocketToWS(tcpSocket, webSocket, slvResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote, enableSocks);

	// when remoteSocket is ready, pass to websocket
	// remote--> ws
	remoteSocketToWS(tcpSocket, webSocket, slvResponseHeader, retry, log);
}

/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer
 * @param {string} earlyDataHeader for ws 0rtt
 * @param {(info: string)=> void} log for ws 0rtt
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				if (readableStreamCancel) {
					return;
				}
				const message = event.data;
				controller.enqueue(message);
			});

			// The event means that the client closed the client -> server stream.
			// However, the server -> client stream is still open until you call close() on the server side.
			// The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
			webSocketServer.addEventListener('close', () => {
				// client send close, need close server
				// if stream is cancel, skip controller.close
				safeCloseWebSocket(webSocketServer);
				if (readableStreamCancel) {
					return;
				}
				controller.close();
			}
			);
			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			}
			);
			// for ws 0rtt
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},

		pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
		},
		cancel(reason) {
			// 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
			// 2. if readableStream is cancel, all controller.close/enqueue need skip,
			// 3. but from testing controller.error still work even if readableStream is cancel
			if (readableStreamCancel) {
				return;
			}
			log(`ReadableStream was canceled, due to ${reason}`)
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	});

	return stream;

}

/**
 * 
 * @param { ArrayBuffer} slvBuffer 
 * @param {string} userID 
 * @returns 
 */
function processSlvHeader(slvBuffer, userID) {
	if (slvBuffer.byteLength < 24) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}

	const version = new Uint8Array(slvBuffer.slice(0, 1));
	let isValidUser = false;
	let isUDP = false;
	if (stringify(new Uint8Array(slvBuffer.slice(1, 17))) === userID) {
		isValidUser = true;
	}
	if (!isValidUser) {
		return {
			hasError: true,
			message: 'invalid user',
		};
	}

	const optLength = new Uint8Array(slvBuffer.slice(17, 18))[0];
	//skip opt for now

	const command = new Uint8Array(
		slvBuffer.slice(18 + optLength, 18 + optLength + 1)
	)[0];

	// 0x01 TCP
	// 0x02 UDP
	// 0x03 MUX
	if (command === 1) {
	} else if (command === 2) {
		isUDP = true;
	} else {
		return {
			hasError: true,
			message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
		};
	}
	const portIndex = 18 + optLength + 1;
	const portBuffer = slvBuffer.slice(portIndex, portIndex + 2);
	// port is big-Endian in raw data etc 80 == 0x005d
	const portRemote = new DataView(portBuffer).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressBuffer = new Uint8Array(
		slvBuffer.slice(addressIndex, addressIndex + 1)
	);

	// 1--> ipv4  addressLength =4
	// 2--> domain name addressLength=addressBuffer[1]
	// 3--> ipv6  addressLength =16
	const addressType = addressBuffer[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(
				slvBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(
				slvBuffer.slice(addressValueIndex, addressValueIndex + 1)
			)[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(
				slvBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(
				slvBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			// 2001:0db8:85a3:0000:0000:8a2e:0370:7334
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			// seems no need add [] for ipv6
			break;
		default:
			return {
				hasError: true,
				message: `invild  addressType is ${addressType}`,
			};
	}

	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		slvVersion: version,
		isUDP,
	};
}


/**
 * 
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} slvResponseHeader 
 * @param {(() => Promise<void>) | null} retry
 * @param {*} log 
 */
async function remoteSocketToWS(remoteSocket, webSocket, slvResponseHeader, retry, log) {
	// remote--> ws
	let remoteChunkCount = 0;
	let chunks = [];
	/** @type {ArrayBuffer | null} */
	let slvHeader = slvResponseHeader;
	let hasIncomingData = false; // check if remoteSocket has incoming data
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {
				},
				/**
				 * 
				 * @param {Uint8Array} chunk 
				 * @param {*} controller 
				 */
				async write(chunk, controller) {
					hasIncomingData = true;
					// remoteChunkCount++;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error(
							'webSocket.readyState is not open, maybe close'
						);
					}
					if (slvHeader) {
						webSocket.send(await new Blob([slvHeader, chunk]).arrayBuffer());
						slvHeader = null;
					} else {
						// seems no need rate limit this, CF seems fix this??..
						// if (remoteChunkCount > 20000) {
						// 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
						// 	await delay(1);
						// }
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
					// safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(
				`remoteSocketToWS has exception `,
				error.stack || error
			);
			safeCloseWebSocket(webSocket);
		});

	// seems is cf connect socket have error,
	// 1. Socket.closed will have error
	// 2. Socket.readable will be close without any data coming
	if (hasIncomingData === false && retry) {
		log(`retry`)
		retry();
	}
}

/**
 * 
 * @param {string} base64Str 
 * @returns 
 */
function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { error: null };
	}

	try {
		// go use modified Base64 for URL rfc4648 which js atob not support
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { error };
	}
}

/**
 * This is not real UUID validation
 * @param {string} uuid 
 */
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
/**
 * Normally, WebSocket will not has exceptions when close.
 * @param {import("@cloudflare/workers-types").WebSocket} socket
 */
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) {
		throw TypeError("Stringified UUID is invalid");
	}
	return uuid;
}


/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} slvResponseHeader 
 * @param {(string)=> void} log 
 */
async function handleUDPOutBound(webSocket, slvResponseHeader, log) {

	let isSlvHeaderSent = false;
	const transformStream = new TransformStream({
		start(controller) {

		},
		transform(chunk, controller) {
			// udp message 2 byte is the the length of udp data
			// TODO: this should have bug, beacsue maybe udp chunk can be in two websocket message
			for (let index = 0; index < chunk.byteLength;) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(
					chunk.slice(index + 2, index + 2 + udpPakcetLength)
				);
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
		flush(controller) {
		}
	});

	// only handle dns udp for now
	transformStream.readable.pipeTo(new WritableStream({
		async write(chunk) {
			const resp = await fetch('https://1.1.1.1/dns-query',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/dns-message',
					},
					body: chunk,
				})
			const dnsQueryResult = await resp.arrayBuffer();
			const udpSize = dnsQueryResult.byteLength;
			const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
			if (webSocket.readyState === WS_READY_STATE_OPEN) {
				log(`doh success and dns message length is ${udpSize}`);
				if (isSlvHeaderSent) {
					webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
				} else {
					webSocket.send(await new Blob([slvResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
					isSlvHeaderSent = true;
				}
			}
		}
	})).catch((error) => {
		log('dns udp has error' + error)
	});

	const writer = transformStream.writable.getWriter();

	return {
		/**
		 * 
		 * @param {Uint8Array} chunk 
		 */
		write(chunk) {
			writer.write(chunk);
		}
	};
}

/**
 * 
 * @param {string} userID 
 * @param {string | null} hostName
 * @returns {string}
 */

const 协议类型_TY_PTL = atob('ZG14bGMzTT0=');         // [protocol]
const 别名_AAS = atob('YW1saGRHVmphQT09');           // jiatech
const 加密方式_PNE = atob('Ym05dVpRPT0=');            // none
const 传输协议_TS_PTL = atob('ZDNNPQ==');             // ws
const 端口_PT = atob('TkRReg==');                    // 443
const 加密算法_EN_ALG = atob('ZEd4eg==');             // tls
const 指纹_FP = atob('Y21GdVpHOXRhWHBsWkE9PQ==');    // randomized
const 路径_PT = atob('THo5bFpEMHlOVFl3');            // /?ed=2560;

function getSLVHomePage(userID, hostName) {

	const 协议类型 = atob(协议类型_TY_PTL);
	const 别名 = atob(别名_AAS);
	const 地址 = hostName;
	const 端口 = Number(atob(端口_PT));

	const 用户ID = userID;
	const 加密方式 = atob(加密方式_PNE);

	const 传输层协议 = atob(传输协议_TS_PTL);
	const 伪装域名 = hostName;
	const 路径 = atob(路径_PT);

	const 传输层安全 = [atob(加密算法_EN_ALG), true];
	const 服务器名称指示 = hostName;
	const 指纹 = atob(指纹_FP);

	const URI = `${协议类型}://${用户ID}@${地址}:${端口}\u003f\u0065\u006e\u0063\u0072\u0079` + 'p' + `${atob('dGlvbj0=') + 加密方式}\u0026\u0073\u0065\u0063\u0075\u0072\u0069\u0074\u0079\u003d${传输层安全[0]}\u0026\u0073\u006e\u0069\u003d${服务器名称指示}\u0026\u0066\u0070\u003d${指纹}&type=${传输层协议}&host=${伪装域名}\u0026\u0070\u0061\u0074\u0068\u003d${encodeURIComponent(路径)}#${encodeURIComponent(别名)}`;

	return `
################################################################
---------------------------------------------------------------
${URI}
---------------------------------------------------------------
################################################################
`;
}
