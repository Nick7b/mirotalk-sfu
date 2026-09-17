'use strict';

// npx mocha test-MixedAudioRecorder.js
//
// bravio (MEET-73): the recording mix must follow the room. The class is a browser script, so it is
// lifted out of Helpers.js and run against a stand-in AudioContext that only counts connections.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadRecorder() {
    const source = fs.readFileSync(path.join(__dirname, '../public/js/Helpers.js'), 'utf8');
    const start = source.indexOf('class MixedAudioRecorder');
    const end = source.indexOf('// Usage', start);
    class FakeNode {
        constructor() {
            this.outputs = new Set();
        }
        connect(node) {
            this.outputs.add(node);
        }
        disconnect() {
            this.outputs.clear();
        }
    }
    class FakeContext {
        createGain() {
            const node = new FakeNode();
            node.gain = { value: 1 };
            return node;
        }
        createMediaStreamSource(stream) {
            const node = new FakeNode();
            node.trackId = stream.getAudioTracks()[0].id;
            return node;
        }
        createMediaStreamDestination() {
            const node = new FakeNode();
            node.stream = { getTracks: () => [] };
            return node;
        }
        close() {}
    }
    class FakeStream {
        constructor(tracks) {
            this.tracks = tracks;
        }
        getTracks() {
            return this.tracks;
        }
        getAudioTracks() {
            return this.tracks.filter((t) => t.kind === 'audio');
        }
    }
    const window = { AudioContext: FakeContext };
    const context = { window, AudioContext: FakeContext, MediaStream: FakeStream, console: { log() {} } };
    vm.runInNewContext(source.slice(start, end) + '\nthis.MixedAudioRecorder = MixedAudioRecorder;', context);
    return { MixedAudioRecorder: context.MixedAudioRecorder, FakeStream };
}

const track = (id, readyState = 'live') => ({ id, kind: 'audio', readyState });

describe('test-MixedAudioRecorder', () => {
    const { MixedAudioRecorder, FakeStream } = loadRecorder();

    const mixedIds = (recorder) =>
        Array.from(recorder.audioSources).filter((s) => s.outputs.has(recorder.audioDestination)).map((s) => s.trackId).sort();

    it('connects a voice that arrives after recording started (the GRI call)', () => {
        const recorder = new MixedAudioRecorder();
        recorder.getMixedAudioStream([new FakeStream([track('james')]), new FakeStream([track('sport')])]);
        recorder.syncTracks([track('james'), track('sport'), track('rachael')]);
        assert.deepStrictEqual(mixedIds(recorder), ['james', 'rachael', 'sport']);
    });

    it('disconnects a voice that left, and connects it again when it comes back as a new track', () => {
        const recorder = new MixedAudioRecorder();
        recorder.getMixedAudioStream([new FakeStream([track('james')]), new FakeStream([track('sport')])]);
        recorder.syncTracks([track('james')]);
        assert.deepStrictEqual(mixedIds(recorder), ['james']);
        recorder.syncTracks([track('james'), track('sport-2')]);
        assert.deepStrictEqual(mixedIds(recorder), ['james', 'sport-2']);
    });

    it('leaves an ended track out and never connects the same track twice', () => {
        const recorder = new MixedAudioRecorder();
        recorder.getMixedAudioStream([new FakeStream([track('james')])]);
        recorder.syncTracks([track('james'), track('judith'), track('old', 'ended')]);
        recorder.syncTracks([track('james'), track('judith')]);
        assert.strictEqual(recorder.audioSources.length, 2);
        assert.deepStrictEqual(mixedIds(recorder), ['james', 'judith']);
    });

    it('does nothing once the mix has stopped', () => {
        const recorder = new MixedAudioRecorder();
        recorder.getMixedAudioStream([new FakeStream([track('james')])]);
        recorder.stopMixedAudioStream();
        recorder.syncTracks([track('rachael')]);
        assert.strictEqual(recorder.audioSources.length, 0);
    });
});
