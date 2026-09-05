'use strict';

/**
 * bravio (MEET-33-1): one clean audio track per participant, taken at the SFU.
 *
 * WHY THIS EXISTS. The recording this platform transcribes is made in the presenter's BROWSER: it
 * takes every remote participant's audio out of the `<audio>` elements the page is playing,
 * decoded, mixes them into one stream, and encodes that stream a second time. So whisper is asked
 * to read speech that was encoded by WebRTC at speech bitrates, decoded, mixed with other voices,
 * and encoded again. No model fixes that, and the platform already runs the largest whisper there
 * is with the language set.
 *
 * A `PlainTransport` consuming a producer directly gets the participant's own stream as it arrives
 * at the SFU: one speaker, encoded once, before any of the above happens. That is what this does.
 *
 * WHAT IT DELIBERATELY DOES NOT DO YET. It does not name files for the cockpit, it does not decide
 * what happens when a producer or a room closes, and nothing reads what it writes. Those are
 * MEET-33-2 and after. This task answers one question and no others: can a track be captured on
 * this box at all, and what is the file when it is.
 *
 * OFF BY DEFAULT. `media.recording.perTrack` gates it, so the mixed path that people actually rely
 * on is untouched while this is unproven. A new capture path that cannot be turned off would be a
 * new single point of failure on a server whose whole job is not to drop the conversation.
 */

const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const Logger = require('./Logger');
const log = new Logger('TrackRecorder');

/**
 * The port ffmpeg listens on, and the one after it for RTCP.
 *
 * Taken from a range of our own rather than mediasoup's `rtcMinPort..rtcMaxPort`, because those
 * are handed out to real peers and colliding with one would break a call to record it. Even
 * numbers only: RTP convention puts RTCP on the odd port above, and mediasoup's `rtcpMux: false`
 * expects exactly that pairing.
 */
const PORT_BASE = Number(process.env.PER_TRACK_PORT_BASE || 51000);
const PORT_SPAN = Number(process.env.PER_TRACK_PORT_SPAN || 200);
const takenPorts = new Set();

function claimPort() {
    for (let port = PORT_BASE; port < PORT_BASE + PORT_SPAN; port += 2) {
        if (!takenPorts.has(port)) {
            takenPorts.add(port);
            return port;
        }
    }
    throw new Error('no free port for a track recorder');
}

function releasePort(port) {
    takenPorts.delete(port);
}

/** Is per-track recording switched on for this instance? */
function perTrackEnabled() {
    return Boolean(config?.media?.recording?.perTrack);
}

/**
 * The SDP ffmpeg needs to make sense of a bare RTP stream.
 *
 * ffmpeg cannot infer the payload type or the codec from the packets alone, so it is told. The
 * payload type comes from the consumer rather than from a constant: mediasoup picks it per
 * consumer and a hard-coded 111 would work until the day it did not.
 */
function buildSdp(port, codec) {
    const rate = codec.clockRate || 48000;
    const channels = codec.channels || 2;
    const name = (codec.mimeType || 'audio/opus').split('/')[1];
    return [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=bravio-track',
        'c=IN IP4 127.0.0.1',
        't=0 0',
        `m=audio ${port} RTP/AVP ${codec.payloadType}`,
        `a=rtpmap:${codec.payloadType} ${name}/${rate}/${channels}`,
        'a=recvonly',
        '',
    ].join('\n');
}

/**
 * The sidecar that says whose voice is in the file beside it (MEET-33-3).
 *
 * Written atomically, because the cockpit watches this directory and a half-written manifest read
 * mid-write is a track attributed to nobody. Failing to write one is logged and not thrown: a
 * recording with no manifest is a question for a person, and losing the audio as well because the
 * label could not be saved would be the wrong trade.
 */
function writeManifest(manifestPath, data) {
    try {
        const temporary = `${manifestPath}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
        fs.renameSync(temporary, manifestPath);
    } catch (error) {
        log.warn('[bravio] could not write a track manifest', { manifestPath, error: error.message });
    }
}

/**
 * Resolve once something is listening on this UDP port, or throw.
 *
 * Asked by trying to bind it ourselves: a bind that FAILS with EADDRINUSE is proof that ffmpeg
 * has it, which is a fact about the port rather than an assumption about how long a process
 * takes to start. A bind that succeeds means ffmpeg is not ready, so the socket is closed again
 * and the question asked once more.
 */
async function waitForPort(port, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const taken = await new Promise((resolve) => {
            const probe = dgram.createSocket('udp4');
            probe.once('error', () => {
                // EADDRINUSE: somebody else has it, which here means ffmpeg.
                try { probe.close(); } catch { /* never opened */ }
                resolve(true);
            });
            probe.bind(port, '127.0.0.1', () => {
                probe.close(() => resolve(false));
            });
        });
        if (taken) return;
        if (Date.now() > deadline) throw new Error(`ffmpeg never bound port ${port}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/**
 * Start capturing one audio producer to its own file.
 *
 * Returns null when per-track recording is off or the producer is not audio, so the caller can
 * call it unconditionally and this stays the only place that knows the rules.
 *
 * The order matters and is the opposite of the obvious one: **ffmpeg is started before the
 * transport is connected**. mediasoup begins sending the moment `connect` resolves, and a
 * listener that is not there yet means the first packets land on a closed port. Starting the
 * reader first costs a few hundred milliseconds of silence at the head of the file and loses
 * nothing.
 */
async function startTrackRecording(room, peerName, producer, directory) {
    if (!perTrackEnabled() || producer.kind !== 'audio') return null;

    const port = claimPort();
    // MEET-33-3: THE NAME IDENTIFIES THE FILE, THE MANIFEST SAYS WHAT IS IN IT.
    //
    // The first version put the peer name in the file name, which meant mangling it to survive a
    // filesystem: spaces to underscores, anything non-ASCII dropped. Reading a person back out of
    // that is guessing, and MEET-5 already taught this lesson from the other side, where the
    // browser's local clock was baked into the recording name and lied about when the meeting
    // happened.
    //
    // So the name carries only a uuid, and everything a reader needs is in a JSON sidecar written
    // beside it: the room, the peer verbatim, and the times from THIS server's clock rather than
    // any browser's.
    const trackId = uuidv4();
    const file = path.join(directory, `Track_${room.id}_${trackId}.ogg`);
    const manifestPath = path.join(directory, `Track_${room.id}_${trackId}.json`);
    const startedAt = new Date().toISOString();

    let transport = null;
    let consumer = null;
    let child = null;

    try {
        transport = await room.router.createPlainTransport({
            listenIp: { ip: '127.0.0.1' },
            rtcpMux: false,
            comedia: false,
        });
        consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: room.router.rtpCapabilities,
            // Paused, and resumed only once ffmpeg is listening. An unpaused consumer starts
            // producing the moment it exists.
            paused: true,
        });

        const codec = consumer.rtpParameters.codecs[0];
        const sdpPath = `${file}.sdp`;
        fs.writeFileSync(sdpPath, buildSdp(port, codec));

        child = spawn(
            process.env.FFMPEG_BIN || 'ffmpeg',
            [
                '-loglevel', 'error',
                '-protocol_whitelist', 'file,udp,rtp',
                '-i', sdpPath,
                // Copied, not re-encoded. The whole point of this landing is to stop encoding
                // the same speech twice, so the one thing this must not do is encode it again.
                '-c:a', 'copy',
                '-y', file,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        child.stderr.on('data', (data) =>
            log.warn('[bravio] track recorder said', { room: room.id, peer: peerName, err: String(data).slice(0, 200) }),
        );

        // WAIT FOR THE PORT, DO NOT SLEEP AND HOPE. Measured on the dev box, twice: with a flat
        // 400 ms wait the FIRST recorder in a fresh container captured zero bytes and the second
        // captured fine, every time. The producers were unpaused with a score of 10 in both
        // cases, so the sender was healthy and the loss was on this side.
        //
        // The cause is that mediasoup connects its UDP socket to this address. Sending to a port
        // nothing has bound yet draws an ICMP port-unreachable, and a CONNECTED UDP socket turns
        // that into a permanent error rather than a dropped packet: the first ffmpeg was still
        // starting, the socket failed once and never recovered, while the second started warm
        // and made it in time. A sleep tuned to be long enough today is the same bug waiting for
        // a busier server.
        await waitForPort(port);

        await transport.connect({ ip: '127.0.0.1', port, rtcpPort: port + 1 });
        await consumer.resume();

        // MEET-33-1: the first probe captured the second peer and nothing at all from the first,
        // so the state of the producer at the moment of consuming is worth having in the log
        // rather than reasoned about afterwards. A paused producer sends nothing, and a consumer
        // of one is resumed and still silent.
        log.info('[bravio] per-track recording started', {
            room: room.id,
            peer: peerName,
            file,
            port,
            producerPaused: producer.paused,
            consumerPaused: consumer.paused,
            producerScore: producer.score,
        });
        // If the producer is paused when we attach, say so when it resumes: that tells apart
        // "never sent anything" from "sent nothing while we were listening".
        consumer.on('producerpause', () => log.warn('[bravio] track producer paused', { peer: peerName }));
        consumer.on('producerresume', () => log.warn('[bravio] track producer resumed', { peer: peerName }));

        // MEET-33-1: ask mediasoup what it actually sent, five seconds in. The port-wait fix was
        // built on a theory about ICMP and connected UDP sockets, and it did not change the
        // result, so the next step is a measurement rather than a third theory. bytesSent above
        // zero puts the fault after this transport, at ffmpeg; zero puts it before, at the
        // consumer.
        setTimeout(async () => {
            try {
                const [transportStats, consumerStats] = await Promise.all([
                    transport.getStats(),
                    consumer.getStats(),
                ]);
                log.info('[bravio] track flow check', {
                    peer: peerName,
                    port,
                    transportBytesSent: transportStats?.[0]?.bytesSent,
                    consumerBytesSent: consumerStats?.[0]?.byteCount ?? consumerStats?.[0]?.bytesSent,
                    consumerPacketCount: consumerStats?.[0]?.packetCount,
                    consumerPaused: consumer.paused,
                    producerPaused: consumer.producerPaused,
                });
            } catch (error) {
                log.warn('[bravio] track flow check failed', { peer: peerName, error: error.message });
            }
        }, 5000);
        // Written now rather than at the end, so a recorder that dies with the process still
        // leaves behind something that says whose voice is in the file next to it.
        writeManifest(manifestPath, {
            room: room.id,
            trackId,
            peerName: String(peerName ?? ''),
            producerId: producer.id,
            startedAt,
            endedAt: null,
            file: path.basename(file),
        });

        const recorder = {
            file,
            sdpPath,
            manifestPath,
            port,
            transport,
            consumer,
            child,
            peerName,
            room: room.id,
            trackId,
            startedAt,
            producerId: producer.id,
            stopping: null,
        };

        // MEET-33-2: mediasoup says when this is over, so nothing here has to watch MiroTalk's
        // own bookkeeping for it. `producerclose` fires when the participant stops sending, which
        // is what leaving a meeting does; `transportclose` covers the router going away underneath
        // it. Both end up in the same idempotent stop.
        //
        // Without this a participant who left after five minutes kept an ffmpeg and a port until
        // the last person closed the room, which on a long meeting is most of an hour of process
        // per person who stepped out.
        consumer.once('producerclose', () => {
            log.info('[bravio] track producer closed, stopping recorder', { peer: peerName });
            stopTrackRecording(recorder).catch((error) =>
                log.error('[bravio] stopping on producerclose failed', { error: error.message }),
            );
        });
        consumer.once('transportclose', () => {
            stopTrackRecording(recorder).catch(() => {
                /* the room is going away; the room teardown logs its own failures */
            });
        });

        return recorder;
    } catch (error) {
        log.error('[bravio] per-track recording failed to start', {
            room: room.id,
            peer: peerName,
            error: error.message,
        });
        // Everything or nothing: a half-built recorder holds a port and a transport and records
        // no audio, which is the worst of both.
        try { child?.kill('SIGKILL'); } catch { /* already gone */ }
        try { consumer?.close(); } catch { /* already closed */ }
        try { transport?.close(); } catch { /* already closed */ }
        releasePort(port);
        return null;
    }
}

/**
 * Stop one track recorder and let ffmpeg finish its file.
 *
 * SIGINT rather than SIGKILL, because ffmpeg writes the container's trailer on a clean exit and
 * a killed one leaves a file that plays but reports no duration. That is exactly the bug MEET-16
 * had to write a remux to repair, and it is cheaper not to cause it.
 */
async function stopTrackRecording(recorder) {
    if (!recorder) return null;
    // IDEMPOTENT, because there are now three ways in: the producer closing, the transport
    // closing, and the room being torn down. Two of those routinely fire for the same recorder
    // when somebody leaves, and stopping twice would close a consumer that is already closed,
    // release a port that has been handed to somebody else, and log a second stop for a file
    // that was finished a minute ago.
    if (recorder.stopping) return recorder.stopping;
    recorder.stopping = stopTrackRecordingOnce(recorder);
    return recorder.stopping;
}

async function stopTrackRecordingOnce(recorder) {
    const { child, consumer, transport, port, sdpPath, file } = recorder;
    // Stop the media first, then LET FFMPEG NOTICE. Closing the consumer and the transport ends
    // the packets; ffmpeg's RTP reader then times out by itself, writes its trailer and exits
    // with a complete file.
    try { consumer?.close(); } catch { /* already closed */ }
    try { transport?.close(); } catch { /* already closed */ }
    await new Promise((resolve) => {
        if (!child || child.exitCode !== null) return resolve();
        // MEASURED, and it is why this is not a one-line stop. Across four probe runs the file
        // that came out complete was ALWAYS the one whose ffmpeg exited on its own, when its
        // peer left and the RTP stream stopped; the file that came out EMPTY was always the one
        // this function stopped. Signalling ffmpeg while it is still mid-stream loses everything
        // buffered, and with `-c copy` into ogg that turned out to be the whole file.
        //
        // So the signals are a backstop rather than the mechanism. ffmpeg took about seven
        // seconds to notice silence in the runs above, so fifteen is generous without being a
        // hang, and SIGINT then SIGKILL only ever run when it has not managed by itself.
        const kill = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, 20000);
        const nudge = setTimeout(() => {
            log.warn('[bravio] track recorder did not stop on its own, signalling', { file });
            try { child.kill('SIGINT'); } catch { /* already gone */ }
        }, 15000);
        child.once('close', () => {
            clearTimeout(nudge);
            clearTimeout(kill);
            resolve();
        });
    });
    try { fs.rmSync(sdpPath, { force: true }); } catch { /* nothing to remove */ }
    releasePort(port);
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    // The manifest is completed rather than replaced, so whatever was written at the start
    // survives a stop that goes wrong.
    writeManifest(recorder.manifestPath, {
        room: recorder.room,
        trackId: recorder.trackId,
        peerName: String(recorder.peerName ?? ''),
        producerId: recorder.producerId,
        startedAt: recorder.startedAt,
        endedAt: new Date().toISOString(),
        file: path.basename(file),
        bytes,
    });
    log.info('[bravio] per-track recording stopped', { file, bytes });
    return { file, bytes };
}

/**
 * Clear up after a crash (MEET-33-2).
 *
 * An ffmpeg started by this process dies with it, because it is a child and the container has no
 * init to adopt it. What survives is the litter: an `.sdp` beside every recording that was in
 * flight, and a zero-byte `.ogg` for any track that never got its trailer written. Neither is
 * readable by anything and both would sit there until somebody noticed.
 *
 * Only run at startup, and only on files whose recorder cannot still exist, because this process
 * has just started and therefore owns none of them.
 */
function sweepOrphanedTracks(directory) {
    if (!perTrackEnabled() || !fs.existsSync(directory)) return { sdp: 0, empty: 0 };
    const result = { sdp: 0, empty: 0 };
    for (const name of fs.readdirSync(directory)) {
        if (!name.startsWith('Track_')) continue;
        const full = path.join(directory, name);
        try {
            if (name.endsWith('.sdp')) {
                fs.rmSync(full, { force: true });
                result.sdp += 1;
            } else if (name.endsWith('.tmp')) {
                // A manifest that was being written when the process died.
                fs.rmSync(full, { force: true });
                result.sdp += 1;
            } else if (name.endsWith('.ogg') && fs.statSync(full).size === 0) {
                // A zero-byte track is a recorder that was interrupted before ffmpeg wrote
                // anything. There is no audio in it to lose, and its manifest describes nothing,
                // so both go.
                fs.rmSync(full, { force: true });
                fs.rmSync(full.replace(/\.ogg$/, '.json'), { force: true });
                result.empty += 1;
            }
        } catch (error) {
            log.warn('[bravio] could not clear an orphaned track file', { name, error: error.message });
        }
    }
    if (result.sdp || result.empty) {
        log.info('[bravio] cleared orphaned per-track files from a previous run', result);
    }
    return result;
}

module.exports = {
    startTrackRecording,
    stopTrackRecording,
    perTrackEnabled,
    buildSdp,
    sweepOrphanedTracks,
};
