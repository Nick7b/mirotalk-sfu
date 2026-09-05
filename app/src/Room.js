'use strict';

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const config = require('./config');
const { startTrackRecording, stopTrackRecording } = require('./TrackRecorder');
const RtmpStreaming = require('./RtmpStreaming');
const Logger = require('./Logger');
const log = new Logger('Room');

const { audioLevelObserverEnabled, activeSpeakerObserverEnabled } = config.mediasoup.router;

module.exports = class Room {
    constructor(room_id, worker, io) {
        this.id = room_id;
        // Unique, one-time-use identifier for this specific room/conference instance.
        // Generated when the room is created (first peer joins) and destroyed with the room
        // (last peer leaves). Reusing the same room name later yields a brand-new sessionId,
        // so webhook events and recordings can be reliably grouped per meeting instance.
        this.sessionId = uuidv4();
        this.worker = worker;
        this.webRtcServer = worker.appData.webRtcServer;
        this.webRtcServerActive = config.mediasoup.webRtcServerActive;
        this.io = io;
        this.audioLevelObserver = null;
        this.audioLevelObserverEnabled = audioLevelObserverEnabled !== undefined ? audioLevelObserverEnabled : true;
        this.audioLastUpdateTime = 0;
        this.activeSpeakerObserverEnabled =
            activeSpeakerObserverEnabled !== undefined ? activeSpeakerObserverEnabled : false;
        this.activeSpeakerObserver = null;
        // bravio (MEET-31): who is speaking, reported on CHANGE rather than continuously.
        //
        // The observer below already fires ten times a second with the loudest producer, and
        // every one of those is broadcast into the room so the UI can draw a ring. What was
        // missing is anybody OUTSIDE the room being told, and forwarding the raw stream would be
        // six hundred webhook posts a minute for a conversation between two people.
        //
        // So this holds the last speaker actually reported and the server hangs `onSpeakerChange`
        // on the room if it wants to hear about it. Null means nobody is speaking, which is a
        // change worth reporting as well: it is what closes a turn, rather than leaving one open
        // until the next person happens to start.
        this.bravioSpeaker = null;
        this.bravioSpeakerAt = 0;
        this.bravioSilenceTimer = null;
        /** Producer id to its own recorder (MEET-33). Empty unless per-track recording is on. */
        this.bravioTrackRecorders = new Map();
        this.onSpeakerChange = null;
        // ##########################
        this._isBroadcasting = false;
        // ##########################
        this._isLocked = false;
        this._isLobbyEnabled = false;
        this._isJoinLocked = false;
        this._roomPassword = null;
        this._hostOnlyRecording = false;
        // Server-side whiteboard lock state. Authoritative — does not depend on the client
        // clicking the lock button. Used to drop non-presenter whiteboard writes when set.
        this._wbIsLock = false;
        // ##########################
        this.recording = {
            recSyncServerToS3: (config?.integrations?.s3?.enabled && config?.media?.recording?.uploadToS3) || false,
            recSyncServerRecording: config?.media?.recording?.enabled || false,
            recSyncServerEndpoint: config?.media?.recording?.endpoint || '',
            // bravio: see config.media.recording.force and .autoFrom.
            recSyncForce: config?.media?.recording?.force || false,
            recSyncAutoFrom: config?.media?.recording?.autoFrom || 0,
        };
        // ##########################

        this.notifications = {
            mode: {
                email: '',
            },
            events: {
                join: false,
            },
        };

        this._moderator = {
            video_start_privacy: false,
            audio_start_muted: false,
            video_start_hidden: false,
            audio_cant_unmute: false,
            video_cant_unhide: false,
            screen_cant_share: false,
            chat_cant_privately: false,
            chat_cant_publicly: false,
            chat_cant_chatgpt: false,
            chat_cant_deep_seek: false,
            media_cant_sharing: false,
            polls_cant_create: false,
        };
        this._followMe = null;
        this.survey = config?.features?.survey;
        this.redirect = config?.features?.redirect;
        this.videoAIEnabled = config?.integrations?.videoAI?.enabled || false;
        this.videoAISessionTimeLimit = config?.integrations?.videoAI?.sessionTimeLimit || 0;
        this.peers = new Map();
        this.bannedPeers = new Map(); // uuid -> timestamp, with TTL-based expiration
        this.webRtcTransport = config.mediasoup.webRtcTransport;
        this.router = null;
        this.routerSettings = config.mediasoup.router;
        this.routerReady = this.createTheRouter();

        // RTMP configuration
        this.rtmpStreaming = new RtmpStreaming(this);

        // Polls
        this.polls = [];

        this.isHostProtected = config?.security?.host?.protected || false;

        // Share Media
        this.shareMediaData = {};

        this.maxParticipants = config?.moderation?.room?.maxParticipants || 1000;
        this.globalLobby = config?.moderation?.room?.lobby || false;
    }

    // ####################################################
    // ROOM INFO
    // ####################################################

    toJson() {
        return {
            id: this.id,
            sessionId: this.sessionId,
            broadcasting: this._isBroadcasting,
            recording: this.recording,
            // bravio: whether this instance has an assistant of its own to answer in the room,
            // and what to call it. Empty means the conversation is removed rather than shown
            // doing nothing (MEET-36, MEET-40).
            bravioAssistant: Boolean(config?.security?.host?.assistant_api_endpoint),
            bravioAssistantName: config?.security?.host?.assistant_name || 'Assistent',
            config: {
                isLocked: this._isLocked,
                isLobbyEnabled: this._isLobbyEnabled,
                isJoinLocked: this._isJoinLocked,
                hostOnlyRecording: this._hostOnlyRecording,
            },
            rtmp: {
                enabled: this.rtmpStreaming.rtmp && this.rtmpStreaming.rtmp.enabled,
                fromFile: this.rtmpStreaming.rtmp && this.rtmpStreaming.rtmp.fromFile,
                fromUrl: this.rtmpStreaming.rtmp && this.rtmpStreaming.rtmp.fromUrl,
                fromStream: this.rtmpStreaming.rtmp && this.rtmpStreaming.rtmp.fromStream,
                allowCustomUrl: this.rtmpStreaming.rtmp && this.rtmpStreaming.rtmp.allowCustomUrl,
            },
            hostProtected: this.isHostProtected,
            moderator: this._moderator,
            followMe: this._followMe,
            survey: this.survey,
            redirect: this.redirect,
            videoAIEnabled: this.videoAIEnabled,
            videoAISessionTimeLimit: this.videoAISessionTimeLimit,
            chatGPTEnabled: config?.integrations?.chatGPT?.enabled || false,
            whisperEnabled: config?.integrations?.whisper?.enabled || false,
            whisperSegmentSeconds: config?.integrations?.whisper?.segmentSeconds || 5,
            thereIsPolls: this.thereIsPolls(),
            shareMediaData: this.shareMediaData,
            dominantSpeaker: this.activeSpeakerObserverEnabled,
            peers: JSON.stringify([...this.peers]),
            peersCount: this.getPeersCount(),
            maxParticipants: this.maxParticipants,
            maxParticipantsReached: this.peers.size > this.maxParticipants,
            globalLobby: this.globalLobby,
        };
    }

    getSessionId() {
        return this.sessionId;
    }

    // ##############################################
    // SHARE MEDIA
    // ##############################################

    updateShareMedia(data) {
        this.shareMediaData = data;
    }

    // ##############################################
    // POLLS
    // ##############################################

    thereIsPolls() {
        return this.polls.length > 0;
    }

    getPolls() {
        return this.polls;
    }

    convertPolls(polls) {
        return polls.map((poll) => {
            const voters = poll.voters ? Object.fromEntries(poll.voters.entries()) : {};
            return { ...poll, voters };
        });
    }

    // ##############################################
    // RTMP (delegated to RtmpStreaming)
    // ##############################################

    isRtmpFileStreamerActive() {
        return this.rtmpStreaming.isRtmpFileStreamerActive();
    }

    async getRTMP(dir) {
        return this.rtmpStreaming.getRTMP(dir);
    }

    async startRTMP(socket_id, room, host, port, file, customRtmpUrl) {
        return this.rtmpStreaming.startRTMP(socket_id, room, host, port, file, customRtmpUrl);
    }

    stopRTMP() {
        return this.rtmpStreaming.stopRTMP();
    }

    isRtmpUrlStreamerActive() {
        return this.rtmpStreaming.isRtmpUrlStreamerActive();
    }

    async startRTMPfromURL(socket_id, room, host, port, inputVideoURL, customRtmpUrl) {
        return this.rtmpStreaming.startRTMPfromURL(socket_id, room, host, port, inputVideoURL, customRtmpUrl);
    }

    stopRTMPfromURL() {
        return this.rtmpStreaming.stopRTMPfromURL();
    }

    getRTMPUrl(host, port) {
        return this.rtmpStreaming.getRTMPUrl(host, port);
    }

    generateRTMPUrl(baseURL, streamPath, secretKey, expirationHours) {
        return this.rtmpStreaming.generateRTMPUrl(baseURL, streamPath, secretKey, expirationHours);
    }

    // ####################################################
    // ROUTER
    // ####################################################

    async createTheRouter() {
        const { mediaCodecs } = this.routerSettings;
        const router = await this.worker.createRouter({
            mediaCodecs,
        });

        this.router = router;
        const observerPromises = [];
        if (this.audioLevelObserverEnabled) {
            log.debug('Audio Level Observer enabled, starting observation...');
            observerPromises.push(
                this.startAudioLevelObservation().catch((error) => {
                    log.error('Failed to start audio level observation', error);
                })
            );
        }
        if (this.activeSpeakerObserverEnabled) {
            log.debug('Active Speaker Observer enabled, starting observation...');
            observerPromises.push(
                this.startActiveSpeakerObserver().catch((error) => {
                    log.error('Failed to start active speaker observer', error);
                })
            );
        }
        await Promise.all(observerPromises);

        this.router.observer.on('close', () => {
            log.debug('---------------> Router is now closed as the last peer has left the room', {
                room: this.id,
            });
        });

        return router;
    }

    async ready() {
        await this.routerReady;
        return this;
    }

    getRtpCapabilities() {
        return this.router.rtpCapabilities;
    }

    closeRouter() {
        if (this.router && !this.router.closed) {
            this.router.close();
            log.debug('Router closed', { router_id: this.router.id });
        }
    }

    /**
     * bravio (MEET-33-1): stop every per-track recorder this room started.
     *
     * Room teardown only. Stopping when a single producer closes, and surviving a crash between
     * the two, is MEET-33-2; what this covers is the guaranteed leak, which is that a room ending
     * would otherwise leave one ffmpeg per participant running for ever. Awaited, because each
     * stop is what lets ffmpeg write its trailer, and a file with no duration is the bug MEET-16
     * had to write a remux to repair.
     */
    async bravioStopAllTracks() {
        const recorders = [...this.bravioTrackRecorders.values()];
        this.bravioTrackRecorders.clear();
        for (const recorder of recorders) {
            try {
                await stopTrackRecording(recorder);
            } catch (error) {
                log.error('[bravio] stopping a track recorder failed', { error: error.message });
            }
        }
    }

    async close() {
        await this.bravioStopAllTracks();
        this.closeAudioLevelObserver();
        this.closeActiveSpeakerObserver();
        this.rtmpStreaming.closeAll();
        this.closeRouter();
        log.debug('Room closed', { room_id: this.id });
    }

    // ####################################################
    // PRODUCER AUDIO LEVEL OBSERVER
    // ####################################################

    async startAudioLevelObservation() {
        log.debug('Start audioLevelObserver for signaling active speaker...');

        this.audioLevelObserver = await this.router.createAudioLevelObserver({
            maxEntries: 1,
            threshold: -70,
            interval: 100,
        });

        this.audioLevelObserver.on('volumes', (volumes) => {
            this.sendActiveSpeakerVolume(volumes);
        });
        this.audioLevelObserver.on('silence', () => {
            //log.debug('audioLevelObserver', { volume: 'silence' });
            // bravio (MEET-31): silence closes the current turn. Without this a turn would run
            // until somebody else spoke, so the last person to talk before a five minute pause
            // would appear to have been talking through all of it.
            this.bravioReportSpeaker(null);
        });
    }

    /**
     * bravio (MEET-31): tell the server when the speaker CHANGES, and only then.
     *
     * Two rules, and both exist because the raw signal is ten events a second. A repeat of the
     * current speaker is not a change and is dropped. A change that arrives within
     * MIN_TURN_MS of the last one is dropped as well, because the loudest producer flickers
     * between two people who are talking over each other, and a turn per flicker would produce a
     * transcript attributed to nobody in particular at enormous length.
     *
     * The cost of that second rule is honest and worth writing down: genuine rapid exchange is
     * smoothed into fewer, longer turns. This is the cheap half of MEET-31 and the half that
     * cannot fix it; MEET-33 records each track separately and has no such limit.
     */
    bravioReportSpeaker(peerName) {
        const MIN_TURN_MS = 700;
        // How long silence must last before it ends somebody's turn.
        //
        // MEASURED, not chosen: a live probe on 5-9-2026 produced turns 250 ms long, one per
        // second, because the observer's `silence` event closed a turn the instant the sound
        // dipped and the next sound opened a new one. Real speech dips like that between every
        // phrase, so a real conversation would have been shredded into hundreds of sub-second
        // turns per person.
        //
        // Attribution survives that, since many short turns by one speaker still overlap the
        // line. CONFIDENCE does not: the gaps count as nobody speaking, so coverage falls and
        // every line would come back below the confident mark. A screen where everything looks
        // uncertain says exactly as much as one where nothing does, and MEET-32 exists to make
        // that distinction mean something.
        const SILENCE_MS = 1500;

        // Silence is a DELAYED close, so a pause for breath does not end a turn. Anybody
        // speaking before the timer fires cancels it and keeps the turn they were already in.
        if (peerName === null) {
            if (this.bravioSpeaker === null || this.bravioSilenceTimer) return;
            this.bravioSilenceTimer = setTimeout(() => {
                this.bravioSilenceTimer = null;
                this.bravioCommitSpeaker(null);
            }, SILENCE_MS);
            return;
        }
        if (this.bravioSilenceTimer) {
            clearTimeout(this.bravioSilenceTimer);
            this.bravioSilenceTimer = null;
        }
        if (peerName === this.bravioSpeaker) return;
        if (Date.now() - this.bravioSpeakerAt < MIN_TURN_MS) return;
        this.bravioCommitSpeaker(peerName);
    }

    /** Record the change and tell whoever is listening. Split out so the silence timer shares it. */
    bravioCommitSpeaker(peerName) {
        if (peerName === this.bravioSpeaker) return;
        const now = Date.now();
        this.bravioSpeaker = peerName;
        this.bravioSpeakerAt = now;
        if (typeof this.onSpeakerChange === 'function') {
            this.onSpeakerChange(this.id, peerName, now);
        }
    }

    sendActiveSpeakerVolume(volumes) {
        try {
            if (!Array.isArray(volumes) || volumes.length === 0) {
                throw new Error('Invalid volumes array');
            }

            if (Date.now() > this.audioLastUpdateTime + 100) {
                this.audioLastUpdateTime = Date.now();

                const { producer, volume } = volumes[0];
                const audioVolume = Math.round(Math.pow(10, volume / 70) * 10); // Scale volume to 1-10

                if (audioVolume > 1) {
                    this.peers.forEach((peer) => {
                        const { id, peer_audio, peer_name } = peer;
                        peer.producers.forEach((peerProducer) => {
                            if (peerProducer.id === producer.id && peerProducer.kind === 'audio' && peer_audio) {
                                const data = {
                                    peer_id: id,
                                    peer_name: peer_name,
                                    audioVolume: audioVolume,
                                };
                                // log.debug('Sending audio volume', data);
                                this.sendToAll('audioVolume', data);
                                // bravio (MEET-31): the same fact, reported outward on change.
                                this.bravioReportSpeaker(peer_name);
                                return;
                            }
                        });
                    });
                }
            }
        } catch (error) {
            log.error('Error sending active speaker volume', error.message);
        }
    }

    async addProducerToAudioLevelObserver(producer) {
        if (!this.audioLevelObserverEnabled || !this.audioLevelObserver || this.audioLevelObserver.closed) return;

        try {
            await this.audioLevelObserver.addProducer(producer);
            log.debug('Producer added to audio level observer', { producer });
        } catch (error) {
            log.warn('Failed to add producer to audio level observer', { producer, error: error.message });
        }
    }

    closeAudioLevelObserver() {
        // bravio (MEET-31): the pending silence close goes with the observer. Left running it
        // would fire against a room that no longer exists and report a speaker change for a
        // meeting that ended, which is the sort of row nobody can explain a week later.
        if (this.bravioSilenceTimer) {
            clearTimeout(this.bravioSilenceTimer);
            this.bravioSilenceTimer = null;
        }
        if (this.audioLevelObserver && !this.audioLevelObserver.closed) {
            this.audioLevelObserver.close();
            this.audioLevelObserver = null;
            log.debug('Audio Level Observer closed');
        }
    }

    // ####################################################
    // PRODUCER DOMINANT ACTIVE SPEAKER
    // ####################################################

    async startActiveSpeakerObserver() {
        log.debug('Start activeSpeakerObserver for signaling dominant speaker...');
        this.activeSpeakerObserver = await this.router.createActiveSpeakerObserver();
        this.activeSpeakerObserver.on('dominantspeaker', (dominantSpeaker) => {
            if (!dominantSpeaker.producer) {
                return;
            }
            log.debug('activeSpeakerObserver "dominantspeaker" event', dominantSpeaker.producer.id);
            this.peers.forEach((peer) => {
                const { id, peer_audio, peer_name } = peer;
                if (peer.producers instanceof Map) {
                    for (const peerProducer of peer.producers.values()) {
                        if (
                            peerProducer.id === dominantSpeaker.producer.id &&
                            peerProducer.kind === 'audio' &&
                            peer_audio
                        ) {
                            let videoProducerId = null;
                            for (const p of peer.producers.values()) {
                                if (p.kind === 'video') {
                                    videoProducerId = p.id;
                                    break;
                                }
                            }
                            const data = {
                                producer_id: videoProducerId,
                                peer_id: id,
                                peer_name: peer_name,
                            };
                            log.debug('Sending dominant speaker', data);
                            this.sendToAll('dominantSpeaker', data);
                            break;
                        }
                    }
                }
            });
        });
    }

    async addProducerToActiveSpeakerObserver(producer) {
        if (!this.activeSpeakerObserverEnabled || !this.activeSpeakerObserver || this.activeSpeakerObserver.closed)
            return;

        try {
            await this.activeSpeakerObserver.addProducer(producer);
            log.debug('Producer added to active speaker observer', { producer });
        } catch (error) {
            log.warn('Failed to add producer to active speaker observer', { producer, error: error.message });
        }
    }

    closeActiveSpeakerObserver() {
        if (this.activeSpeakerObserver && !this.activeSpeakerObserver.closed) {
            this.activeSpeakerObserver.close();
            this.activeSpeakerObserver = null;
            log.debug('Active Speaker Observer closed');
        }
    }

    // ####################################################
    // ROOM NOTIFICATIONS
    // ####################################################

    updateRoomNotifications(data) {
        log.debug('Update room notifications', data);
        this.notifications = data.notifications;
    }

    getRoomNotifications() {
        log.debug('get room notifications', this.notifications);
        return this.notifications;
    }

    // ####################################################
    // ROOM MODERATOR
    // ####################################################

    updateRoomModeratorALL(data) {
        this._moderator = data;
        log.debug('Update room moderator all data', this._moderator);
    }

    updateRoomModerator(data) {
        log.debug('Update room moderator', data);
        switch (data.type) {
            case 'video_start_privacy':
                this._moderator.video_start_privacy = data.status;
                break;
            case 'audio_start_muted':
                this._moderator.audio_start_muted = data.status;
                break;
            case 'video_start_hidden':
                this._moderator.video_start_hidden = data.status;
                break;
            case 'audio_cant_unmute':
                this._moderator.audio_cant_unmute = data.status;
                break;
            case 'video_cant_unhide':
                this._moderator.video_cant_unhide = data.status;
                break;
            case 'screen_cant_share':
                this._moderator.screen_cant_share = data.status;
                break;
            case 'chat_cant_privately':
                this._moderator.chat_cant_privately = data.status;
                break;
            case 'chat_cant_publicly':
                this._moderator.chat_cant_publicly = data.status;
                break;
            case 'chat_cant_chatgpt':
                this._moderator.chat_cant_chatgpt = data.status;
                break;
            case 'chat_cant_deep_seek':
                this._moderator.chat_cant_deep_seek = data.status;
                break;
            case 'media_cant_sharing':
                this._moderator.media_cant_sharing = data.status;
                break;
            case 'polls_cant_create':
                this._moderator.polls_cant_create = data.status;
                break;
            default:
                break;
        }
    }

    // ####################################################
    // FOLLOW ME
    // ####################################################

    setFollowMe(data) {
        this._followMe = data;
        log.debug('Set follow me', this._followMe);
    }

    // ####################################################
    // PEERS
    // ####################################################

    addPeer(peer) {
        this.peers.set(peer.id, peer);
    }

    delPeer(peer) {
        this.peers.delete(peer.id);
    }

    getPeer(socket_id) {
        if (!this.peers.has(socket_id)) return;

        const peer = this.peers.get(socket_id);

        return peer;
    }

    getPeers() {
        return this.peers;
    }

    getPeersCount() {
        return this.peers.size;
    }

    getProducerListForPeer(socket_id) {
        const producerList = [];
        this.peers.forEach((peer, peerId) => {
            // Skip the requesting peer's own producers to prevent self-consumption (echo)
            if (peerId === socket_id) return;
            const { peer_name, peer_info } = peer;
            peer.producers.forEach((producer) => {
                producerList.push({
                    producer_id: producer.id,
                    producer_socket_id: peerId,
                    peer_name: peer_name,
                    peer_info: peer_info,
                    type: producer.appData.mediaType,
                });
            });
        });
        return producerList;
    }

    getProducerById(producerId) {
        for (const peer of this.peers.values()) {
            const producer = peer.getProducer(producerId);
            if (producer && !producer.closed) return producer;
        }
        return null;
    }

    removePeer(socket_id) {
        if (!this.peers.has(socket_id)) return;

        const peer = this.getPeer(socket_id);

        peer.close();

        this.delPeer(peer);

        if (this.getPeersCount() === 0) {
            this.close();
        }
    }

    getPresenterPeers() {
        return Array.from(this.peers.values()).filter((peer) => peer.peer_presenter);
    }

    getLobbyPeers() {
        return Array.from(this.peers.values()).filter((peer) => peer.peer_lobby);
    }

    // ####################################################
    // WebRTC TRANSPORT
    // ####################################################

    getWebRtcTransportOptions() {
        const {
            iceConsentTimeout = 35,
            initialAvailableOutgoingBitrate,
            listenInfos,
            maxSendMessageSize = 262144,
            maxReceiveMessageSize = 262144,
        } = this.webRtcTransport;
        return {
            ...(this.webRtcServerActive ? { webRtcServer: this.webRtcServer } : { listenInfos: listenInfos }),
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            iceConsentTimeout,
            initialAvailableOutgoingBitrate,
            enableSctp: true,
            // mediasoup 3.20.0: numSctpStreams/maxSctpMessageSize removed;
            // use maxSendMessageSize / maxReceiveMessageSize instead.
            maxSendMessageSize,
            maxReceiveMessageSize,
        };
    }

    async createWebRtcTransport(socket_id) {
        if (!this.peers.has(socket_id)) {
            throw new Error(`Peer with socket ID ${socket_id} not found in the room`);
        }

        const webRtcTransportOptions = this.getWebRtcTransportOptions();

        log.debug('webRtcTransportOptions ----->', webRtcTransportOptions);

        let transport;
        try {
            transport = await this.router.createWebRtcTransport(webRtcTransportOptions);
            if (!transport) {
                throw new Error('Failed to create WebRTC Transport');
            }
        } catch (error) {
            log.error('Error creating WebRTC Transport', { error: error.message, socket_id });
            throw new Error('Error creating WebRTC Transport');
        }

        if (!transport) {
            throw new Error(`Transport not found for socket ID ${socket_id}`);
        }

        if (transport.closed) {
            throw new Error('Transport is already closed');
        }

        const { id, type, iceParameters, iceCandidates, dtlsParameters, sctpParameters } = transport;
        const { maxIncomingBitrate, minimumAvailableOutgoingBitrate } = this.webRtcTransport;

        if (maxIncomingBitrate) {
            try {
                await transport.setMaxIncomingBitrate(maxIncomingBitrate);
            } catch (error) {
                log.warn('Failed to set max incoming bitrate', error);
            }
        }

        if (minimumAvailableOutgoingBitrate) {
            try {
                await transport.setMinOutgoingBitrate(minimumAvailableOutgoingBitrate);
            } catch (error) {
                log.warn('Failed to set minimum outgoing bitrate', error);
            }
        }

        const peer = this.getPeer(socket_id);

        if (!peer) {
            if (!transport.closed) transport.close();
            throw new Error(`Peer with socket ID ${socket_id} left before transport could be added`);
        }

        try {
            peer.addTransport(transport);
        } catch (error) {
            log.error('Failed to add peer transport', error);
            throw new Error(`Failed to add peer transport ${id}`);
        }

        log.debug('Transport created', {
            room_id: this.id,
            transport_id: transport.id,
            type: type,
            peer_name: peer.peer_name,
        });

        const { peer_name } = peer;
        const { iceConsentTimeout = 35 } = this.webRtcTransport;
        let iceDisconnectTimeout = null;

        transport.observer.on('newproducer', (producer) => {
            log.debug('---> new producer created [id:%s]', producer.id);
        });

        transport.observer.on('newconsumer', (consumer) => {
            log.debug('---> new consumer created [id:%s]', consumer.id);
        });

        transport.observer.on('close', () => {
            if (iceDisconnectTimeout) {
                clearTimeout(iceDisconnectTimeout);
                iceDisconnectTimeout = null;
            }
            peer.delTransport(transport.id);
            this.send(socket_id, 'transportClosed', { transport_id: transport.id });
            transport.removeAllListeners();
            transport.observer.removeAllListeners();
            log.debug('Transport closed', {
                peer_name: peer_name,
                transport_id: transport.id,
                transport_closed: transport.closed,
            });
        });

        transport.on('icestatechange', (iceState) => {
            const iceLog = {
                peer_name: peer_name,
                transport_id: id,
                iceState: iceState,
            };
            log.debug('ICE state changed', iceLog);

            if (iceState === 'disconnected') {
                log.debug('ICE state disconnected for transport waiting before closing', iceLog);
                iceDisconnectTimeout = setTimeout(() => {
                    iceDisconnectTimeout = null;
                    if (transport.iceState === 'disconnected') {
                        log.warn('Closing transport due to prolonged ICE disconnection', iceLog);
                        if (!transport.closed) {
                            transport.close();
                        }
                    }
                }, iceConsentTimeout * 1000); // Wait iceConsentTimeout seconds before closing
            } else {
                // Clear pending timeout when ICE state recovers or moves to another state
                if (iceDisconnectTimeout) {
                    clearTimeout(iceDisconnectTimeout);
                    iceDisconnectTimeout = null;
                }
                if (iceState === 'closed') {
                    log.warn('ICE state closed, closing transport', iceLog);
                    if (!transport.closed) {
                        transport.close();
                    }
                }
            }
        });

        transport.on('sctpstatechange', (sctpState) => {
            log.debug('SCTP state changed', {
                peer_name: peer_name,
                transport_id: id,
                sctpState: sctpState,
            });
        });

        transport.on('dtlsstatechange', (dtlsState) => {
            if (dtlsState === 'failed' || dtlsState === 'closed') {
                log.warn('DTLS state changed, closing peer', {
                    peer_name: peer_name,
                    transport_id: id,
                    dtlsState: dtlsState,
                });
                if (!transport.closed) {
                    transport.close();
                }
            }
        });

        return {
            id: id,
            iceParameters: iceParameters,
            iceCandidates: iceCandidates,
            dtlsParameters: dtlsParameters,
            sctpParameters: sctpParameters,
        };
    }

    async connectPeerTransport(socket_id, transport_id, dtlsParameters) {
        if (!socket_id || !transport_id || !dtlsParameters) {
            throw new Error('Missing required parameters for connecting peer transport');
        }

        if (!this.peers.has(socket_id)) {
            throw new Error(`Peer with socket ID ${socket_id} not found in the room`);
        }

        const peer = this.getPeer(socket_id);

        try {
            await peer.connectTransport(transport_id, dtlsParameters);
            log.debug('Peer transport connected successfully', {
                socket_id,
                transport_id,
                peer_name: peer.peer_name,
            });
        } catch (error) {
            log.error(`Failed to connect peer transport for socket ID ${socket_id}`, {
                transport_id,
                error: error.message,
                peer_name: peer.peer_name,
            });
            throw new Error(`Failed to connect transport for peer with socket ID ${socket_id}`);
        }

        return '[Room|connectPeerTransport] done';
    }

    // ####################################################
    // PRODUCE
    // ####################################################

    async produce(socket_id, producerTransportId, rtpParameters, kind, type) {
        if (!socket_id || !producerTransportId || !rtpParameters || !kind || !type) {
            throw new Error('Missing required parameters for producing media');
        }

        if (!this.peers.has(socket_id)) {
            throw new Error(`Peer with socket ID ${socket_id} not found in the room`);
        }

        const peer = this.getPeer(socket_id);
        const { peer_name, peer_info } = peer;

        if (!peer.hasTransport(producerTransportId)) {
            throw new Error(`Transport with ID ${producerTransportId} not found for peer ${socket_id}`);
        }

        let peerProducer;
        try {
            peerProducer = await peer.createProducer(producerTransportId, rtpParameters, kind, type);
        } catch (error) {
            log.error(`Error creating producer for peer ${peer.peer_name} with socket ID ${socket_id}`, {
                producerTransportId,
                kind,
                type,
                error: error.message,
            });
            throw new Error(
                `Failed to create producer for peer ${peer.peer_name} with transport ID ${producerTransportId}`
            );
        }

        if (!peerProducer) {
            throw new Error(
                `Failed to create producer for peer ${peer_name} with ID ${producerTransportId} for peer ${socket_id}`
            );
        }

        const { id } = peerProducer;

        // bravio (MEET-33-1): capture this person's audio on its own, straight from the SFU.
        //
        // Deliberately not awaited. Starting a recorder involves a transport, a consumer and a
        // spawned process, and a peer who is trying to speak should not wait on any of that; if
        // it fails it is logged and the meeting carries on with the browser recording it always
        // had. `startTrackRecording` answers null when the feature is off or the producer is not
        // audio, so this line does not need to know the rules.
        startTrackRecording(this, peer_name, peerProducer, path.join(__dirname, config.media.recording.dir))
            .then((recorder) => {
                if (!recorder) return;
                this.bravioTrackRecorders.set(id, recorder);
                // MEET-33-2: the recorder stops itself when the producer closes, so the map has
                // to let go of it too. Otherwise a long meeting accumulates an entry per person
                // who ever spoke, and the teardown walks a list of recorders that finished
                // hours ago.
                recorder.consumer.once('producerclose', () => this.bravioTrackRecorders.delete(id));
                recorder.consumer.once('transportclose', () => this.bravioTrackRecorders.delete(id));
            })
            .catch((error) => log.error('[bravio] per-track recording threw', { error: error.message }));

        const producerTransport = peer.getTransport(producerTransportId);

        if (!producerTransport) {
            throw new Error(`Producer transport with ID ${producerTransportId} not found for peer ${peer_name}`);
        }

        this.broadCast(socket_id, 'newProducers', [
            {
                producer_id: id,
                producer_socket_id: socket_id,
                peer_name: peer_name,
                peer_info: peer_info,
                type: type,
            },
        ]);

        log.debug('Producer created successfully', {
            producerTransportId,
            producer_id: id,
            peer_name: peer.peer_name,
            kind,
            type,
            paused: peerProducer.paused,
            appData: peerProducer.appData,
            transport_state: `ICE:${producerTransport.iceState}, DTLS:${producerTransport.dtlsState}`,
            codecs: rtpParameters.codecs?.map((c) => c.mimeType) || [],
        });

        return id;
    }

    closeProducer(socket_id, producer_id) {
        if (!this.peers.has(socket_id)) return;

        const peer = this.getPeer(socket_id);

        try {
            peer.closeProducer(producer_id);
        } catch (error) {
            log.error(`Error closing producer for peer ${socket_id}`, error);
            throw new Error(`Error closing producer with ID ${producer_id} for peer ${socket_id}`);
        }
    }

    // ####################################################
    // CONSUME
    // ####################################################

    async consume(socket_id, consumer_transport_id, producerId, rtpCapabilities, type) {
        if (!socket_id || !consumer_transport_id || !producerId || !rtpCapabilities || !type) {
            throw new Error('Missing required parameters for consuming media');
        }

        if (!this.peers.has(socket_id)) {
            throw new Error(`Peer with socket ID ${socket_id} not found in the room`);
        }

        const peer = this.getPeer(socket_id);
        const { peer_name } = peer;

        if (!this.getProducerById(producerId)) {
            const error = new Error(`Producer with ID ${producerId} is no longer available`);
            error.code = 'PRODUCER_NOT_FOUND';
            error.retryable = false;
            throw error;
        }

        if (!this.router.canConsume({ producerId, rtpCapabilities })) {
            throw new Error(
                `Cannot consume producer for peer ${peer_name} with ID ${producerId} type ${type}, router validation failed`
            );
        }

        let peerConsumer;
        try {
            peerConsumer = await peer.createConsumer(consumer_transport_id, producerId, rtpCapabilities);
        } catch (error) {
            const transportUnavailable = error.code === 'CONSUMER_TRANSPORT_NOT_FOUND';
            const logDetails = {
                consumer_transport_id,
                producerId,
                type,
                error: error.message,
            };

            transportUnavailable
                ? log.warn(
                      `Skipped consumer for peer ${peer_name} because its transport is no longer available`,
                      logDetails
                  )
                : log.error(`Error creating consumer for peer ${peer_name} with socket ID ${socket_id}`, logDetails);

            const wrapped = new Error(
                `Failed to create consumer for peer ${peer_name} with transport ID ${consumer_transport_id} and producer ID ${producerId} type ${type} for peer ${socket_id}`
            );
            wrapped.code = error.code;
            wrapped.transient = error.transient;
            wrapped.retryable = error.retryable;
            throw wrapped;
        }

        if (!peerConsumer) {
            throw new Error(
                `Consumer creation failed for peer ${peer_name} with transport ID ${consumer_transport_id} and producer ID ${producerId}`
            );
        }

        const consumerTransport = peer.getTransport(consumer_transport_id);

        if (!consumerTransport) {
            throw new Error(`Consumer transport with ID ${consumer_transport_id} not found for peer ${peer_name}`);
        }

        const { consumer, params, reused } = peerConsumer;
        const { id, kind } = consumer;

        if (!reused) {
            consumer.once('producerclose', () => {
                log.debug('Consumer closed due to "producerclose" event', {
                    consumer_id: id,
                    producer_id: producerId,
                    peer_name,
                });

                peer.removeConsumer(id);

                // Notify the client that the consumer is closed
                this.send(socket_id, 'consumerClosed', {
                    consumer_id: id,
                    consumer_kind: kind,
                });
            });
        }

        log.debug('Consumer created successfully', {
            consumer_transport_id,
            consumer_id: id,
            producer_id: producerId,
            peer_name,
            kind,
            type,
            paused: consumer.paused,
            producerPaused: consumer.producerPaused,
            reused,
            transport_state: `ICE:${consumerTransport.iceState}, DTLS:${consumerTransport.dtlsState}`,
        });

        return params;
    }

    // ####################################################
    // PRODUCE DATA (DataChannel)
    // ####################################################

    async produceData(socket_id, transportId, sctpStreamParameters, label, protocol, appData) {
        if (!socket_id || !transportId || !sctpStreamParameters) {
            throw new Error('Missing required parameters for producing data');
        }

        if (!this.peers.has(socket_id)) {
            throw new Error(`Peer with socket ID ${socket_id} not found in the room`);
        }

        const peer = this.getPeer(socket_id);
        const { peer_name, peer_info } = peer;

        if (!peer.hasTransport(transportId)) {
            throw new Error(`Transport with ID ${transportId} not found for peer ${socket_id}`);
        }

        let dataProducer;
        try {
            dataProducer = await peer.createDataProducer(transportId, sctpStreamParameters, label, protocol, appData);
        } catch (error) {
            log.error(`Error creating data producer for peer ${peer_name} with socket ID ${socket_id}`, {
                transportId,
                label,
                error: error.message,
            });
            throw new Error(`Failed to create data producer for peer ${peer_name} with transport ID ${transportId}`);
        }

        if (!dataProducer) {
            throw new Error(`Failed to create data producer for peer ${peer_name} with transport ID ${transportId}`);
        }

        // Notify other peers about the new data producer
        this.broadCast(socket_id, 'newDataProducer', {
            dataProducerId: dataProducer.id,
            peer_id: socket_id,
            peer_name: peer_name,
            peer_info: peer_info,
            label: dataProducer.label,
        });

        log.debug('DataProducer created successfully', {
            transportId,
            dataProducer_id: dataProducer.id,
            peer_name,
            label: dataProducer.label,
        });

        return dataProducer.id;
    }

    // ####################################################
    // CONSUME DATA (DataChannel)
    // ####################################################

    async consumeData(socket_id, consumerTransportId, dataProducerId) {
        if (!socket_id || !consumerTransportId || !dataProducerId) {
            throw new Error('Missing required parameters for consuming data');
        }

        if (!this.peers.has(socket_id)) {
            throw new Error(`Peer with socket ID ${socket_id} not found in the room`);
        }

        const peer = this.getPeer(socket_id);
        const { peer_name } = peer;

        let result;
        try {
            result = await peer.createDataConsumer(consumerTransportId, dataProducerId);
        } catch (error) {
            const logDetails = {
                consumerTransportId,
                dataProducerId,
                error: error.message,
            };
            // Transient races (producer/transport already closed) are expected, not real errors
            error.transient
                ? log.warn(`Skipped data consumer for peer ${peer_name} with socket ID ${socket_id}`, logDetails)
                : log.error(
                      `Error creating data consumer for peer ${peer_name} with socket ID ${socket_id}`,
                      logDetails
                  );

            const wrapped = new Error(
                `Failed to create data consumer for peer ${peer_name} with transport ID ${consumerTransportId}: ${error.message}`
            );
            wrapped.transient = error.transient;
            throw wrapped;
        }

        if (!result) {
            throw new Error(
                `Data consumer creation failed for peer ${peer_name} with transport ID ${consumerTransportId}`
            );
        }

        const { dataConsumer, params } = result;

        dataConsumer.once('dataproducerclose', () => {
            log.debug('DataConsumer closed due to "dataproducerclose" event', {
                dataConsumer_id: dataConsumer.id,
                dataProducer_id: dataProducerId,
                peer_name,
            });

            peer.removeDataConsumer(dataConsumer.id);

            this.send(socket_id, 'dataConsumerClosed', {
                dataConsumer_id: dataConsumer.id,
            });
        });

        const consumerTransport = peer.getTransport(consumerTransportId);

        log.debug('DataConsumer created successfully', {
            consumerTransportId,
            dataConsumer_id: dataConsumer.id,
            dataProducer_id: dataProducerId,
            peer_name,
            label: dataConsumer.label,
            transport_state: consumerTransport
                ? `ICE:${consumerTransport.iceState}, DTLS:${consumerTransport.dtlsState}`
                : 'unknown',
        });

        return params;
    }

    // Get list of data producers for a peer (excluding their own)
    getDataProducerListForPeer(socket_id) {
        const dataProducerList = [];
        this.peers.forEach((peer, peerId) => {
            if (peerId === socket_id) return;
            const { peer_name, peer_info } = peer;
            peer.dataProducers.forEach((dataProducer) => {
                dataProducerList.push({
                    dataProducerId: dataProducer.id,
                    peer_id: peerId,
                    peer_name: peer_name,
                    peer_info: peer_info,
                    label: dataProducer.label,
                });
            });
        });
        return dataProducerList;
    }

    // ####################################################
    // HANDLE BANNED PEERS
    // ####################################################

    addBannedPeer(uuid) {
        if (!this.bannedPeers.has(uuid)) {
            this.bannedPeers.set(uuid, Date.now());
            log.debug('Added to the banned list', {
                uuid: uuid,
                banned: [...this.bannedPeers.keys()],
            });
        }
    }

    isBanned(uuid) {
        if (!this.bannedPeers.has(uuid)) return false;
        const bannedAt = this.bannedPeers.get(uuid);
        const BAN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
        if (Date.now() - bannedAt > BAN_TTL_MS) {
            this.bannedPeers.delete(uuid);
            return false;
        }
        return true;
    }

    // ####################################################
    // ROOM STATUS
    // ####################################################

    // GET
    isBroadcasting() {
        return this._isBroadcasting;
    }
    getPassword() {
        return this._roomPassword;
    }

    // BOOL
    isLocked() {
        return this._isLocked;
    }
    isLobbyEnabled() {
        return this._isLobbyEnabled;
    }
    isJoinLocked() {
        return this._isJoinLocked;
    }
    isGlobalLobbyEnabled() {
        return this.globalLobby;
    }
    isHostOnlyRecording() {
        return this._hostOnlyRecording;
    }

    // SET
    setIsBroadcasting(status) {
        this._isBroadcasting = status;
    }
    setLocked(status, password) {
        this._isLocked = status;
        this._roomPassword = password;
    }
    setLobbyEnabled(status) {
        this._isLobbyEnabled = status;
    }
    setJoinLocked(status) {
        this._isJoinLocked = status;
    }
    setHostOnlyRecording(status) {
        this._hostOnlyRecording = status;
    }
    getWhiteboardLock() {
        return this._wbIsLock;
    }
    setWhiteboardLock(status) {
        this._wbIsLock = Boolean(status);
    }

    // ####################################################
    // SENDER
    // ####################################################

    broadCast(socket_id, action, data) {
        for (let otherID of Array.from(this.peers.keys()).filter((id) => id !== socket_id)) {
            this.send(otherID, action, data);
        }
    }

    sendTo(socket_id, action, data) {
        for (let peer_id of Array.from(this.peers.keys()).filter((id) => id === socket_id)) {
            this.send(peer_id, action, data);
        }
    }

    sendToAll(action, data) {
        for (let peer_id of Array.from(this.peers.keys())) {
            this.send(peer_id, action, data);
        }
    }

    send(socket_id, action, data) {
        this.io.to(socket_id).emit(action, data);
    }
};
