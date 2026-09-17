'use strict';

class MixedAudioRecorder {
    constructor(useGainNode = true) {
        this.useGainNode = useGainNode;
        this.gainNode = null;
        this.audioSources = [];
        this.sourcesByTrack = new Map();
        this.audioDestination = null;
        this.audioContext = this.createAudioContext();
    }

    createAudioContext() {
        if (window.AudioContext) {
            return new AudioContext();
        } else if (window.webkitAudioContext) {
            return new webkitAudioContext();
        } else if (window.mozAudioContext) {
            return new mozAudioContext();
        } else {
            throw new Error('Web Audio API is not supported in this browser');
        }
    }

    getMixedAudioStream(audioStreams) {
        this.audioSources = [];
        this.sourcesByTrack = new Map();

        if (this.useGainNode) {
            this.gainNode = this.audioContext.createGain();
            this.gainNode.connect(this.audioContext.destination);
            this.gainNode.gain.value = 0;
        }

        audioStreams.forEach((stream) => {
            if (!stream || !stream.getTracks().filter((t) => t.kind === 'audio').length) {
                return;
            }

            console.log('Mixed audio tracks to add on MediaStreamAudioDestinationNode --->', stream.getTracks());

            let audioSource = this.audioContext.createMediaStreamSource(stream);

            if (this.useGainNode) {
                audioSource.connect(this.gainNode);
            }
            this.audioSources.push(audioSource);
            this.sourcesByTrack.set(stream.getAudioTracks()[0].id, audioSource);
        });

        this.audioDestination = this.audioContext.createMediaStreamDestination();
        this.audioSources.forEach((audioSource) => {
            audioSource.connect(this.audioDestination);
        });

        return this.audioDestination.stream;
    }

    // bravio (MEET-73): THE MIX FOLLOWS THE ROOM, not the moment recording started.
    //
    // The mix used to be built once, from the audio elements present when the presenter began
    // recording. The server starts recording as soon as a second person arrives, so everyone who
    // came after that was never in the file: in the GRI call of 17-9-2026 Rachael joined eighteen
    // seconds after the start and the 698 MB recording held one voice. The caller hands the live
    // audio tracks of the room every second; a track not yet in the mix is connected, a track that
    // has left the room (or ended, as a consumer does when it is rebuilt after a reconnect) is
    // disconnected. The destination track the MediaRecorder holds stays the same throughout.
    syncTracks(tracks) {
        if (!this.audioContext || !this.audioDestination) return;
        const live = tracks.filter((track) => track && track.kind === 'audio' && track.readyState === 'live');
        const wanted = new Set(live.map((track) => track.id));
        for (const [id, source] of this.sourcesByTrack) {
            if (wanted.has(id)) continue;
            source.disconnect();
            this.audioSources = this.audioSources.filter((s) => s !== source);
            this.sourcesByTrack.delete(id);
            console.log('Mixed audio track left the recording --->', id);
        }
        live.forEach((track) => {
            if (this.sourcesByTrack.has(track.id)) return;
            const source = this.audioContext.createMediaStreamSource(new MediaStream([track]));
            if (this.useGainNode && this.gainNode) {
                source.connect(this.gainNode);
            }
            source.connect(this.audioDestination);
            this.audioSources.push(source);
            this.sourcesByTrack.set(track.id, source);
            console.log('Mixed audio track joined the recording --->', track.id);
        });
    }

    stopMixedAudioStream() {
        if (this.useGainNode) {
            this.gainNode.disconnect();
            this.gainNode = null;
        }
        if (this.audioSources.length) {
            this.audioSources.forEach((source) => {
                source.disconnect();
            });
            this.audioSources = [];
        }
        this.sourcesByTrack = new Map();
        if (this.audioDestination) {
            this.audioDestination.disconnect();
            this.audioDestination = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        console.log('Stop Mixed Audio Stream');
    }
}

// Usage
// const audioRecorder = new MixedAudioRecorder();
// To start recording, call audioRecorder.getMixedAudioStream(audioStreams);
// To stop recording, call audioRecorder.stopMixedAudioStream();
// Credits: https://github.com/muaz-khan/MultiStreamsMixer
