/**
 * ONDAS LAN // HUB & MIXER DE ÁUDIO MULTI-DISPOSITIVOS (PC -> iPhone / Android)
 * Motor completo WebAudio + WebRTC Stereo Opus + WebSocket Binary PCM16 + iOS Keep-Alive
 */
(function () {
  'use strict';

  // ==========================================================================
  // 1. DETECÇÃO DO APARELHO E ESTADO GLOBAL
  // ==========================================================================

  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isWindows = /Win/i.test(navigator.platform || ua);
  const isMac = /Mac/i.test(navigator.platform || ua) && !isIOS;

  function detectDefaultDeviceName() {
    if (isIOS) return 'iPhone • Safari';
    if (isAndroid) return 'Android • Chrome';
    if (isWindows) return 'PC Windows • Principal';
    if (isMac) return 'Mac • Studio';
    return 'PC Linux • Desktop';
  }

  function detectDeviceType() {
    if (isIOS) return 'iphone';
    if (isAndroid) return 'android';
    if (isWindows) return 'windows';
    return 'desktop';
  }

  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  const urlInitParams = new URLSearchParams(window.location.search);
  const urlRoom = (urlInitParams.get('room') || '').replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase().slice(0, 12);
  if (urlRoom) {
    localStorage.setItem('ondas_room_code', urlRoom);
  }

  const state = {
    myId: null,
    myNumericId: 0,
    deviceName: localStorage.getItem('ondas_device_name') || detectDefaultDeviceName(),
    deviceType: detectDeviceType(),
    role: 'both', // 'both' | 'receiver' | 'sender'
    ws: null,
    wsConnected: false,
    hasLocalLanServer: false,
    pingMs: null,

    // Modo P2P Sem Servidor (PeerJS Cloud Signaling + WebRTC Direto no Wi-Fi)
    roomCode: urlRoom || localStorage.getItem('ondas_room_code') || generateRoomCode(),
    rxPeer: null,
    txPeer: null,
    txDataConn: null,
    txMediaCall: null,
    txRetryTimer: null,
    p2pPeersMeta: new Map(),

    // Estado de Transmissão (TX)
    selectedSource: 'system', // 'system' | 'mic' | 'synth'
    transportMode: 'hybrid', // 'hybrid' | 'ws-pcm' | 'webrtc'
    isBroadcasting: false,
    currentSourceLabel: 'Áudio do Sistema',
    localCaptureStream: null,
    txAudioCtx: null,
    txProcessorNode: null,
    txSynthCleanup: null,
    txSeq: 0,

    // WebRTC PeerConnections de saída (sender -> receiverId) e entrada (senderId -> receiver)
    outboundPeers: new Map(),
    inboundPeers: new Map(),

    // Estado do Mixer Receptor (RX)
    audioCtx: null,
    audioUnlocked: false,
    masterGainNode: null,
    masterCompressor: null,
    masterAnalyser: null,
    iosStreamDest: null,
    masterVolume: 1.0,
    masterMuted: false,
    autoDucking: true,
    jitterBufferSec: 0.045,

    // Dispositivos na sala LAN (id -> deviceInfo)
    networkDevices: new Map(),

    // Canais ativos no Mixer (channelId -> channelAudioState)
    mixerChannels: new Map(),

    // Simulação de 3 aparelhos para teste imediato
    simActive: false,
    simTimerIds: []
  };
  localStorage.setItem('ondas_room_code', state.roomCode);

  // ==========================================================================
  // 2. REFERÊNCIAS DOM
  // ==========================================================================

  const dom = {
    subtitle: document.getElementById('device-identity-subtitle'),
    modeButtons: document.querySelectorAll('.mode-btn'),
    wsStatusLed: document.getElementById('ws-status-led'),
    wsStatusText: document.getElementById('ws-status-text'),
    pingReadout: document.getElementById('ping-readout'),
    btnDownloadZip: document.getElementById('btn-download-zip'),

    unlockBanner: document.getElementById('audio-unlock-banner'),
    unlockIcon: document.getElementById('unlock-banner-icon'),
    unlockTitle: document.getElementById('unlock-banner-title'),
    unlockDesc: document.getElementById('unlock-banner-desc'),
    btnActivateAudio: document.getElementById('btn-activate-audio'),
    btnSimulateDevices: document.getElementById('btn-simulate-devices'),

    receiverSection: document.getElementById('receiver-rack-section'),
    senderSection: document.getElementById('sender-rack-section'),

    chkAutoDucking: document.getElementById('chk-auto-ducking'),
    selectJitterBuffer: document.getElementById('select-jitter-buffer'),
    masterSpectrumCanvas: document.getElementById('master-spectrum-canvas'),
    masterDbReadout: document.getElementById('master-db-readout'),
    masterVolumeFader: document.getElementById('master-volume-fader'),
    masterVolumeBadge: document.getElementById('master-volume-badge'),
    btnMuteMaster: document.getElementById('btn-mute-master'),
    btnResetLevels: document.getElementById('btn-reset-levels'),
    mixerChannelsContainer: document.getElementById('mixer-channels-container'),

    sourceCards: document.querySelectorAll('.source-card'),
    windowsGuide: document.getElementById('windows-capture-guide'),
    micSelectorBox: document.getElementById('mic-device-selector-box'),
    selectAudioInput: document.getElementById('select-audio-input'),
    inputDeviceName: document.getElementById('input-device-name'),
    selectTransportMode: document.getElementById('select-transport-mode'),
    chkMuteLocalTab: document.getElementById('chk-mute-local-tab'),
    btnToggleBroadcast: document.getElementById('btn-toggle-broadcast'),
    txLiveLed: document.getElementById('tx-live-led'),
    txLiveStatus: document.getElementById('tx-live-status'),

    qrCodeContainer: document.getElementById('qr-code-container'),
    lanReceiverUrl: document.getElementById('lan-receiver-url'),
    btnCopyLanUrl: document.getElementById('btn-copy-lan-url'),
    inputRoomCode: document.getElementById('input-room-code'),
    btnApplyRoom: document.getElementById('btn-apply-room'),
    ipInterfaceWrap: document.getElementById('ip-interface-selector-wrap'),
    selectLanIp: document.getElementById('select-lan-ip'),
    connectedCount: document.getElementById('connected-count'),
    networkNodesContainer: document.getElementById('network-nodes-container'),
    iosMasterAudio: document.getElementById('ios-master-audio')
  };

  // ==========================================================================
  // 3. MOTOR DE ÁUDIO MASTER & SUPORTE A SEGUNDO PLANO NO IPHONE (iOS SAFARI)
  // ==========================================================================

  function ensureAudioEngine(fromUserGesture = false) {
    if (!state.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new AudioContextClass({
        latencyHint: 'interactive'
      });

      const ctx = state.audioCtx;

      // Compressor / Limiter Master para evitar distorção quando vários aparelhos tocam juntos
      state.masterCompressor = ctx.createDynamicsCompressor();
      state.masterCompressor.threshold.value = -6;
      state.masterCompressor.knee.value = 12;
      state.masterCompressor.ratio.value = 8;
      state.masterCompressor.attack.value = 0.003;
      state.masterCompressor.release.value = 0.15;

      state.masterGainNode = ctx.createGain();
      state.masterGainNode.gain.value = state.masterMuted ? 0 : state.masterVolume;

      state.masterAnalyser = ctx.createAnalyser();
      state.masterAnalyser.fftSize = 128;
      state.masterAnalyser.smoothingTimeConstant = 0.78;

      state.masterCompressor.connect(state.masterGainNode);
      state.masterGainNode.connect(state.masterAnalyser);

      // Roteamento especial para iOS Safari continuar tocando com tela bloqueada
      if (isIOS && typeof ctx.createMediaStreamDestination === 'function') {
        state.iosStreamDest = ctx.createMediaStreamDestination();
        state.masterAnalyser.connect(state.iosStreamDest);
        // Também conecta ao destination padrão caso o elemento <audio> demore para iniciar
        state.masterAnalyser.connect(ctx.destination);
      } else {
        state.masterAnalyser.connect(ctx.destination);
      }

      // Sinal Keep-Alive inaudível (-85 dB) para o iOS nunca suspender o Bluetooth quando o PC ficar em silêncio
      const keepAliveOsc = ctx.createOscillator();
      const keepAliveGain = ctx.createGain();
      keepAliveOsc.frequency.value = 25;
      keepAliveGain.gain.value = 0.00005;
      keepAliveOsc.connect(keepAliveGain);
      keepAliveGain.connect(state.masterCompressor);
      keepAliveOsc.start();
    }

    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }

    if (fromUserGesture) {
      unlockMobileBackgroundAudio();
    }

    return state.audioCtx;
  }

  async function unlockMobileBackgroundAudio() {
    const ctx = ensureAudioEngine(false);
    try {
      await ctx.resume();
    } catch (_) {}

    // Toca um buffer curto para destravar o WebAudio no iOS/Android
    try {
      const silentBuf = ctx.createBuffer(1, 256, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = silentBuf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (_) {}

    // Se estiver no iPhone/iPad, vincula a MediaStream ao <audio playsinline> nativo
    if (state.iosStreamDest && dom.iosMasterAudio) {
      try {
        dom.iosMasterAudio.srcObject = state.iosStreamDest.stream;
        await dom.iosMasterAudio.play();
      } catch (_) {}
    }

    // Garante que todos os streams WebRTC já recebidos toquem imediatamente após o toque no iPhone!
    for (const ch of state.mixerChannels.values()) {
      if (ch.webrtcAudioEl) {
        try {
          await ch.webrtcAudioEl.play();
        } catch (_) {}
      }
    }

    // Configura controles de Tela de Bloqueio / Dynamic Island / AirPods (MediaSession API)
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Mixer Rede Local (PC + Aparelhos)',
          artist: 'Ondas LAN • Fone Unificado',
          album: 'Transmissão Wi-Fi em Tempo Real'
        });

        navigator.mediaSession.setActionHandler('play', () => {
          ensureAudioEngine(false);
          state.masterMuted = false;
          updateMasterGainUI();
          applyChannelGains();
        });

        navigator.mediaSession.setActionHandler('pause', () => {
          state.masterMuted = true;
          updateMasterGainUI();
          applyChannelGains();
        });
      } catch (_) {}
    }

    // Solicita WakeLock para evitar suspensão de Wi-Fi enquanto a tela estiver aberta
    if ('wakeLock' in navigator) {
      try {
        await navigator.wakeLock.request('screen');
      } catch (_) {}
    }

    state.audioUnlocked = true;
    applyChannelGains();
    dom.unlockBanner.classList.add('unlocked');
    dom.unlockIcon.textContent = '✅';
    dom.unlockTitle.textContent = 'Escuta Ativa • Pronto para Receber Áudio no seu Fone Bluetooth';
    dom.unlockDesc.textContent =
      'Motor de baixa latência e suporte a segundo plano ativados. Você pode ajustar o volume individual de cada PC/aparelho abaixo.';
    dom.btnActivateAudio.textContent = '🔊 Motor de Áudio Ativo';
  }

  // ==========================================================================
  // 4. GERENCIAMENTO DE CANAIS DO MIXER (CADA APARELHO = 1 CANAL NA MESA)
  // ==========================================================================

  function getOrCreateMixerChannel(channelId, meta = {}) {
    const ctx = ensureAudioEngine(false);
    let ch = state.mixerChannels.get(channelId);

    if (!ch) {
      // Cadeia de processamento por aparelho:
      // InputGain -> BassFilter -> TrebleFilter -> DuckingGain -> VolumeGain -> StereoPanner -> Analyser -> MasterCompressor
      const inputNode = ctx.createGain();

      const bassFilter = ctx.createBiquadFilter();
      bassFilter.type = 'lowshelf';
      bassFilter.frequency.value = 130;
      bassFilter.gain.value = 0;

      const trebleFilter = ctx.createBiquadFilter();
      trebleFilter.type = 'highshelf';
      trebleFilter.frequency.value = 4200;
      trebleFilter.gain.value = 0;

      const duckingGain = ctx.createGain();
      duckingGain.gain.value = 1.0;

      const volumeGain = ctx.createGain();
      volumeGain.gain.value = 1.0;

      const pannerNode =
        typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : ctx.createGain();

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.65;

      inputNode.connect(bassFilter);
      bassFilter.connect(trebleFilter);
      trebleFilter.connect(duckingGain);
      duckingGain.connect(volumeGain);
      volumeGain.connect(pannerNode);
      pannerNode.connect(analyser);
      analyser.connect(state.masterCompressor);

      ch = {
        id: channelId,
        numericId: meta.numericId || 0,
        name: meta.name || 'Aparelho na Rede',
        deviceType: meta.deviceType || 'windows',
        sourceLabel: meta.sourceLabel || 'Áudio do Sistema',
        transportLabel: meta.transportLabel || 'LAN Stream',
        isSimulated: Boolean(meta.isSimulated),

        inputNode,
        bassFilter,
        trebleFilter,
        duckingGain,
        volumeGain,
        pannerNode,
        analyser,
        timeData: new Float32Array(analyser.fftSize),

        volume: 1.0, // 0.0 a 2.0 (até 200% boost!)
        pan: 0, // -1 (L) a +1 (R)
        bassDb: 0,
        trebleDb: 0,
        muted: false,
        solo: false,
        priority: Boolean(meta.priority),
        isCurrentlyDucked: false,
        currentRms: 0,
        remoteRms: 0,

        // Jitter buffer state para frames binários PCM via WebSocket
        nextPlayTime: 0,
        webrtcActive: false,
        directElementAudio: false,
        webrtcAudioEl: null,
        mediaStreamSource: null
      };

      state.mixerChannels.set(channelId, ch);
      renderMixerChannelsUI();
    } else {
      if (meta.name) ch.name = meta.name;
      if (meta.numericId) ch.numericId = meta.numericId;
      if (meta.deviceType) ch.deviceType = meta.deviceType;
      if (meta.sourceLabel) ch.sourceLabel = meta.sourceLabel;
      if (meta.transportLabel) ch.transportLabel = meta.transportLabel;
      updateChannelHeaderInDOM(ch);
    }

    return ch;
  }

  function attachRemoteWebRtcStreamToChannel(ch, remoteStream) {
    const ctx = ensureAudioEngine(false);

    if (ch.mediaStreamSource) {
      try {
        ch.mediaStreamSource.disconnect();
      } catch (_) {}
      ch.mediaStreamSource = null;
    }
    if (ch.webrtcAudioEl) {
      try {
        ch.webrtcAudioEl.pause();
        ch.webrtcAudioEl.srcObject = null;
        ch.webrtcAudioEl.remove();
      } catch (_) {}
      ch.webrtcAudioEl = null;
    }

    const audioEl = document.createElement('audio');
    audioEl.playsInline = true;
    audioEl.setAttribute('playsinline', '');
    audioEl.setAttribute('webkit-playsinline', '');
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    audioEl.srcObject = remoteStream;

    // No iOS Safari, reproduzir WebRTC direto pelo <audio playsinline> evita o bug do WebKit
    // onde createMediaStreamSource(remoteStream) fica mudo, além de funcionar 100% com tela bloqueada!
    if (isIOS) {
      ch.directElementAudio = true;
      audioEl.muted = false;
      const effVol = state.masterMuted || ch.muted ? 0 : Math.max(0, Math.min(1, ch.volume * state.masterVolume));
      audioEl.volume = effVol;
    } else {
      ch.directElementAudio = false;
      audioEl.muted = true;
      try {
        const mediaSource = ctx.createMediaStreamSource(remoteStream);
        mediaSource.connect(ch.inputNode);
        ch.mediaStreamSource = mediaSource;
      } catch (_) {}
    }

    ch.webrtcActive = true;
    ch.webrtcAudioEl = audioEl;
    updateChannelHeaderInDOM(ch);

    audioEl.play().catch(() => {
      // Se o usuário no iPhone ainda não tocou no botão de ativar escuta, avisa no banner!
      if (!state.audioUnlocked) {
        dom.unlockBanner.classList.remove('unlocked');
        dom.unlockIcon.textContent = '📡';
        dom.unlockTitle.textContent = `Sinal recebido de "${ch.name}"!`;
        dom.unlockDesc.textContent =
          'Toque no botão verde "Ativar Escuta & 2º Plano" ao lado para liberar o som imediatamente no seu fone Bluetooth.';
      }
    });
  }

  function removeMixerChannel(channelId) {
    const ch = state.mixerChannels.get(channelId);
    if (!ch) return;
    try {
      if (ch.mediaStreamSource) ch.mediaStreamSource.disconnect();
      if (ch.webrtcAudioEl) {
        ch.webrtcAudioEl.pause();
        ch.webrtcAudioEl.srcObject = null;
        ch.webrtcAudioEl.remove();
      }
      ch.analyser.disconnect();
    } catch (_) {}
    state.mixerChannels.delete(channelId);
    renderMixerChannelsUI();
  }

  function applyChannelGains() {
    const anySolo = Array.from(state.mixerChannels.values()).some((c) => c.solo);
    const ctx = state.audioCtx;

    for (const ch of state.mixerChannels.values()) {
      const effectivelyMuted = state.masterMuted || ch.muted || (anySolo && !ch.solo);
      const duckFactor = ch.isCurrentlyDucked ? 0.25 : 1.0;

      if (ctx) {
        const targetGain = effectivelyMuted ? 0 : ch.volume;
        ch.volumeGain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
      }

      if (ch.directElementAudio && ch.webrtcAudioEl) {
        ch.webrtcAudioEl.volume = effectivelyMuted
          ? 0
          : Math.max(0, Math.min(1, ch.volume * state.masterVolume * duckFactor));
      }
    }
  }

  function getDeviceIcon(deviceType) {
    switch (deviceType) {
      case 'iphone':
        return '📱';
      case 'android':
        return '🤖';
      case 'windows':
        return '🖥️';
      case 'notebook':
        return '💻';
      case 'tv':
        return '📺';
      default:
        return '🎛️';
    }
  }

  function updateChannelHeaderInDOM(ch) {
    const card = document.getElementById(`ch-card-${ch.id}`);
    if (!card) return;
    const nameEl = card.querySelector('.channel-name');
    const metaEl = card.querySelector('.channel-source-meta');
    const pillEl = card.querySelector('.transport-pill');
    if (nameEl) nameEl.textContent = ch.name;
    if (metaEl) metaEl.textContent = ch.sourceLabel;
    if (pillEl) pillEl.textContent = ch.webrtcActive ? 'WebRTC Opus' : ch.transportLabel;
  }

  function renderMixerChannelsUI() {
    const container = dom.mixerChannelsContainer;
    if (!container) return;

    const channels = Array.from(state.mixerChannels.values());

    if (channels.length === 0) {
      container.innerHTML = `
        <div class="empty-mixer-state" style="grid-column: 1 / -1;">
          <div style="font-size: 2rem;">🎧</div>
          <div class="empty-mixer-title">Nenhum aparelho transmitindo áudio neste instante</div>
          <p class="empty-mixer-sub">
            No seu <strong>PC Windows</strong>, clique em <strong>"📡 Iniciar Transmissão Deste Aparelho"</strong> abaixo — ou clique em <strong>"⚡ Simular 3 Aparelhos no Mixer"</strong> no topo para testar a mixagem multipista agora mesmo!
          </p>
        </div>
      `;
      return;
    }

    container.innerHTML = channels
      .map((ch) => {
        const volPct = Math.round(ch.volume * 100);
        const panText = ch.pan === 0 ? 'C' : ch.pan < 0 ? `L${Math.round(Math.abs(ch.pan) * 100)}` : `R${Math.round(ch.pan * 100)}`;
        const segsHtml = Array.from({ length: 18 }, (_, i) => `<span class="vu-seg" data-seg="${i}"></span>`).join('');

        return `
          <article class="channel-strip" id="ch-card-${ch.id}" data-channel-id="${ch.id}">
            <div class="channel-top">
              <div class="channel-identity">
                <div class="device-avatar">${getDeviceIcon(ch.deviceType)}</div>
                <div>
                  <h3 class="channel-name">${escapeHtml(ch.name)}</h3>
                  <div class="channel-source-meta">${escapeHtml(ch.sourceLabel)}</div>
                </div>
              </div>
              <span class="transport-pill">${escapeHtml(ch.webrtcActive ? 'WebRTC Opus' : ch.transportLabel)}</span>
            </div>

            <!-- Medidor VU de 18 LEDs em tempo real -->
            <div class="vu-meter-bar" id="vu-bar-${ch.id}" aria-label="Nível de sinal de áudio">
              ${segsHtml}
            </div>

            <div class="channel-controls">
              <!-- Fader de Volume (0% até 200% Boost) -->
              <div class="control-line">
                <div class="control-label">
                  <span>VOLUME DO APARELHO</span>
                  <strong id="lbl-vol-${ch.id}" style="color: var(--signal-emerald);">${volPct}%</strong>
                </div>
                <input
                  type="range"
                  class="studio-fader ch-vol-slider"
                  data-id="${ch.id}"
                  min="0"
                  max="200"
                  value="${volPct}"
                />
              </div>

              <!-- Balanço Estéreo (Pan Esquerda / Direita no Fone) -->
              <div class="control-line">
                <div class="control-label">
                  <span>POSIÇÃO NO FONE (PAN L/R)</span>
                  <strong id="lbl-pan-${ch.id}">${panText}</strong>
                </div>
                <input
                  type="range"
                  class="studio-fader ch-pan-slider"
                  data-id="${ch.id}"
                  min="-100"
                  max="100"
                  value="${Math.round(ch.pan * 100)}"
                />
              </div>

              <!-- Equalizador Grave / Agudo Rápido -->
              <div class="eq-mini-row">
                <div class="control-line">
                  <div class="control-label">
                    <span>GRAVES</span>
                    <span id="lbl-bass-${ch.id}">${ch.bassDb >= 0 ? '+' : ''}${ch.bassDb}dB</span>
                  </div>
                  <input
                    type="range"
                    class="studio-fader ch-bass-slider"
                    data-id="${ch.id}"
                    min="-12"
                    max="12"
                    value="${ch.bassDb}"
                  />
                </div>
                <div class="control-line">
                  <div class="control-label">
                    <span>AGUDOS / VOZ</span>
                    <span id="lbl-treble-${ch.id}">${ch.trebleDb >= 0 ? '+' : ''}${ch.trebleDb}dB</span>
                  </div>
                  <input
                    type="range"
                    class="studio-fader ch-treble-slider"
                    data-id="${ch.id}"
                    min="-12"
                    max="12"
                    value="${ch.trebleDb}"
                  />
                </div>
              </div>

              <!-- Botões Mute / Solo / Prioridade (Auto-Ducking) -->
              <div class="channel-buttons-row">
                <button
                  type="button"
                  class="ch-btn ${ch.muted ? 'mute-active' : ''}"
                  data-action="mute"
                  data-id="${ch.id}"
                >
                  ${ch.muted ? 'MUTADO' : 'MUTE'}
                </button>
                <button
                  type="button"
                  class="ch-btn ${ch.solo ? 'solo-active' : ''}"
                  data-action="solo"
                  data-id="${ch.id}"
                >
                  SOLO
                </button>
                <button
                  type="button"
                  class="ch-btn ${ch.priority ? 'priority-active' : ''}"
                  data-action="priority"
                  data-id="${ch.id}"
                  title="Quando este aparelho emitir som, abaixa automaticamente o volume dos outros aparelhos"
                >
                  PRIORIDADE
                </button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    bindChannelStripEvents();
  }

  function bindChannelStripEvents() {
    document.querySelectorAll('.ch-vol-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        ensureAudioEngine(true);
        const id = e.target.dataset.id;
        const ch = state.mixerChannels.get(id);
        if (!ch) return;
        const pct = Number(e.target.value);
        ch.volume = pct / 100;
        const lbl = document.getElementById(`lbl-vol-${id}`);
        if (lbl) lbl.textContent = `${pct}%`;
        applyChannelGains();
      });
    });

    document.querySelectorAll('.ch-pan-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        ensureAudioEngine(true);
        const id = e.target.dataset.id;
        const ch = state.mixerChannels.get(id);
        if (!ch) return;
        const val = Number(e.target.value);
        ch.pan = val / 100;
        if (ch.pannerNode && ch.pannerNode.pan) {
          ch.pannerNode.pan.setTargetAtTime(ch.pan, state.audioCtx.currentTime, 0.015);
        }
        const lbl = document.getElementById(`lbl-pan-${id}`);
        if (lbl) {
          lbl.textContent = val === 0 ? 'C' : val < 0 ? `L${Math.abs(val)}` : `R${val}`;
        }
      });
    });

    document.querySelectorAll('.ch-bass-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        ensureAudioEngine(true);
        const id = e.target.dataset.id;
        const ch = state.mixerChannels.get(id);
        if (!ch) return;
        ch.bassDb = Number(e.target.value);
        ch.bassFilter.gain.setTargetAtTime(ch.bassDb, state.audioCtx.currentTime, 0.02);
        const lbl = document.getElementById(`lbl-bass-${id}`);
        if (lbl) lbl.textContent = `${ch.bassDb >= 0 ? '+' : ''}${ch.bassDb}dB`;
      });
    });

    document.querySelectorAll('.ch-treble-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        ensureAudioEngine(true);
        const id = e.target.dataset.id;
        const ch = state.mixerChannels.get(id);
        if (!ch) return;
        ch.trebleDb = Number(e.target.value);
        ch.trebleFilter.gain.setTargetAtTime(ch.trebleDb, state.audioCtx.currentTime, 0.02);
        const lbl = document.getElementById(`lbl-treble-${id}`);
        if (lbl) lbl.textContent = `${ch.trebleDb >= 0 ? '+' : ''}${ch.trebleDb}dB`;
      });
    });

    document.querySelectorAll('.ch-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        ensureAudioEngine(true);
        const id = e.currentTarget.dataset.id;
        const action = e.currentTarget.dataset.action;
        const ch = state.mixerChannels.get(id);
        if (!ch) return;

        if (action === 'mute') {
          ch.muted = !ch.muted;
        } else if (action === 'solo') {
          ch.solo = !ch.solo;
        } else if (action === 'priority') {
          ch.priority = !ch.priority;
        }

        applyChannelGains();
        renderMixerChannelsUI();
      });
    });
  }

  // ==========================================================================
  // 5. RECEPÇÃO DE ÁUDIO BINÁRIO PCM (WEBSOCKET) E WEBRTC
  // ==========================================================================

  function handleIncomingBinaryPcm(arrayBuffer) {
    if (arrayBuffer.byteLength <= 8) return;
    const view = new DataView(arrayBuffer);
    const senderNumericId = view.getUint16(0, false);
    const sampleRate = view.getUint16(4, false) * 100 || 48000;
    const numChannels = view.getUint8(6) || 2;

    // Descobre a qual dispositivo pertence este numericId
    let senderDevice = null;
    for (const dev of state.networkDevices.values()) {
      if (dev.numericId === senderNumericId) {
        senderDevice = dev;
        break;
      }
    }

    const channelId = senderDevice ? senderDevice.id : `net_${senderNumericId}`;
    if (channelId === state.myId) return; // Não reproduz o próprio eco se for o mesmo aparelho

    const ch = getOrCreateMixerChannel(channelId, {
      numericId: senderNumericId,
      name: senderDevice ? senderDevice.name : `Aparelho #${senderNumericId}`,
      deviceType: senderDevice ? senderDevice.deviceType : 'windows',
      sourceLabel: senderDevice ? senderDevice.sourceLabel : 'Stream PCM Direto',
      transportLabel: 'WS PCM 16-bit'
    });

    // Se o canal já estiver recebendo áudio via WebRTC P2P ativo, ignora o fallback PCM para não duplicar
    if (ch.webrtcActive) return;

    const ctx = ensureAudioEngine(false);
    if (ctx.state !== 'running') return;

    const pcmBytes = arrayBuffer.byteLength - 8;
    const totalSamples = pcmBytes >> 1;
    const framesCount = Math.floor(totalSamples / numChannels);
    if (framesCount <= 0) return;

    const int16 = new Int16Array(arrayBuffer, 8, framesCount * numChannels);
    const audioBuffer = ctx.createBuffer(numChannels, framesCount, sampleRate);

    if (numChannels === 2) {
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      for (let i = 0; i < framesCount; i++) {
        left[i] = int16[i * 2] / 32768;
        right[i] = int16[i * 2 + 1] / 32768;
      }
    } else {
      const mono = audioBuffer.getChannelData(0);
      for (let i = 0; i < framesCount; i++) {
        mono[i] = int16[i] / 32768;
      }
    }

    const now = ctx.currentTime;
    if (ch.nextPlayTime < now || ch.nextPlayTime > now + 0.4) {
      ch.nextPlayTime = now + state.jitterBufferSec;
    }

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ch.inputNode);
    src.start(ch.nextPlayTime);
    ch.nextPlayTime += audioBuffer.duration;
  }

  // ==========================================================================
  // 6. WEBRTC P2P (OPUS ESTÉREO DE ALTA TAXA DE BITS)
  // ==========================================================================

  function enhanceOpusSdp(sdp) {
    // Configura Opus para Estéreo 256kbps com mínima latência e sem corte de música (usedtx=0)
    return sdp.replace(
      /a=fmtp:(\d+) minptime=10;useinbandfec=1/g,
      'a=fmtp:$1 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000;cbr=1;usedtx=0'
    );
  }

  async function initiateWebRtcToReceiver(receiverId) {
    if (!state.isBroadcasting || !state.localCaptureStream) return;
    if (state.transportMode === 'ws-pcm') return; // Modo apenas WebSocket

    closeOutboundPeer(receiverId);

    const pc = new RTCPeerConnection({
      iceServers: [] // Rede local pura (LAN host candidates)
    });

    state.outboundPeers.set(receiverId, pc);

    const audioTracks = state.localCaptureStream.getAudioTracks();
    for (const track of audioTracks) {
      pc.addTrack(track, state.localCaptureStream);
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        sendSignaling({
          type: 'webrtc-ice',
          targetId: receiverId,
          candidate: ev.candidate
        });
      }
    };

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });
      offer.sdp = enhanceOpusSdp(offer.sdp);
      await pc.setLocalDescription(offer);

      sendSignaling({
        type: 'webrtc-offer',
        targetId: receiverId,
        sdp: pc.localDescription
      });
    } catch (err) {
      console.warn('Falha ao criar oferta WebRTC:', err);
    }
  }

  async function handleIncomingWebRtcOffer(msg) {
    const senderId = msg.fromId;
    if (!senderId) return;

    closeInboundPeer(senderId);

    const pc = new RTCPeerConnection({
      iceServers: []
    });
    state.inboundPeers.set(senderId, pc);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        sendSignaling({
          type: 'webrtc-ice',
          targetId: senderId,
          candidate: ev.candidate
        });
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([ev.track]);
      const senderDev = state.networkDevices.get(senderId);

      const ch = getOrCreateMixerChannel(senderId, {
        numericId: msg.fromNumericId || (senderDev && senderDev.numericId) || 0,
        name: (senderDev && senderDev.name) || msg.fromName || 'PC Transmissor',
        deviceType: (senderDev && senderDev.deviceType) || 'windows',
        sourceLabel: (senderDev && senderDev.sourceLabel) || 'Áudio do Sistema',
        transportLabel: 'WebRTC Opus'
      });

      attachRemoteWebRtcStreamToChannel(ch, stream);
    };

    pc.onconnectionstatechange = () => {
      const ch = state.mixerChannels.get(senderId);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (ch) {
          ch.webrtcActive = false;
          updateChannelHeaderInDOM(ch);
        }
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      answer.sdp = enhanceOpusSdp(answer.sdp);
      await pc.setLocalDescription(answer);

      sendSignaling({
        type: 'webrtc-answer',
        targetId: senderId,
        sdp: pc.localDescription
      });
    } catch (err) {
      console.warn('Erro ao processar oferta WebRTC:', err);
    }
  }

  function closeOutboundPeer(receiverId) {
    const pc = state.outboundPeers.get(receiverId);
    if (pc) {
      try {
        pc.close();
      } catch (_) {}
      state.outboundPeers.delete(receiverId);
    }
  }

  function closeInboundPeer(senderId) {
    const pc = state.inboundPeers.get(senderId);
    if (pc) {
      try {
        pc.close();
      } catch (_) {}
      state.inboundPeers.delete(senderId);
    }
  }

  // ==========================================================================
  // 7. TRANSMISSÃO (CAPTURA DO SISTEMA WINDOWS / ABA / MICROFONE / SINTETIZADOR)
  // ==========================================================================

  async function startBroadcasting() {
    if (state.isBroadcasting) {
      stopBroadcasting();
      return;
    }

    let stream = null;
    let sourceLabel = 'Áudio do Sistema Windows';

    try {
      if (state.selectedSource === 'system') {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          alert(
            'A captura de áudio do sistema/aba requer um navegador desktop (Chrome ou Edge no Windows) acessando via http://localhost:3000 ou clique em "Gerador Musical de Teste" para testar neste aparelho.'
          );
          return;
        }

        const suppressLocal = Boolean(dom.chkMuteLocalTab && dom.chkMuteLocalTab.checked);

        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 320 },
            height: { ideal: 180 },
            frameRate: { ideal: 5 }
          },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000,
            suppressLocalAudioPlayback: suppressLocal
          },
          systemAudio: 'include'
        });

        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          stream.getTracks().forEach((t) => t.stop());
          alert(
            'Atenção: Você não marcou a caixinha "Compartilhar também o áudio do sistema / aba" na janela do navegador!\n\nClique novamente em Iniciar Transmissão e marque a opção de compartilhar áudio no canto inferior da janela.'
          );
          return;
        }

        sourceLabel = audioTracks[0].label || 'Áudio do Sistema Windows';
        audioTracks[0].addEventListener('ended', () => {
          stopBroadcasting();
        });
      } else if (state.selectedSource === 'mic') {
        const deviceId = dom.selectAudioInput.value;
        stream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2
          }
        });
        const track = stream.getAudioTracks()[0];
        sourceLabel = (track && track.label) || 'Entrada de Áudio / Aux';
      } else if (state.selectedSource === 'synth') {
        const synthObj = createLiveStereoSynthStream();
        stream = synthObj.stream;
        state.txSynthCleanup = synthObj.cleanup;
        sourceLabel = 'Gerador Musical Estéreo (Teste)';
      }
    } catch (err) {
      console.warn('Captura cancelada ou não permitida:', err);
      return;
    }

    state.localCaptureStream = stream;
    state.isBroadcasting = true;
    state.currentSourceLabel = sourceLabel;

    // Inicia pipeline de envio PCM16 binário via WebSocket (quando servidor LAN local estiver ativo)
    if (state.wsConnected) {
      setupWebSocketPcmTransmitter(stream);
    }

    // Inicia transmissão WebRTC P2P direta para a Sala (funciona sem servidor em GitHub Pages / Web!)
    startPeerJsBroadcastToRoom(stream, sourceLabel);

    // Notifica a sala LAN local que este aparelho está transmitindo
    sendSignaling({
      type: 'stream-state',
      isStreaming: true,
      sourceLabel,
      transportMode: state.transportMode,
      sampleRate: 48000,
      channels: 2
    });

    // Inicia conexões WebRTC P2P locais com receptores WS presentes na sala
    if (state.transportMode !== 'ws-pcm') {
      for (const dev of state.networkDevices.values()) {
        if (dev.id !== state.myId && (dev.role === 'receiver' || dev.role === 'both')) {
          initiateWebRtcToReceiver(dev.id);
        }
      }
    }

    updateBroadcastUI(true, sourceLabel);
  }

  function setupWebSocketPcmTransmitter(stream) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const txCtx = new AudioContextClass({ sampleRate: 48000 });
    state.txAudioCtx = txCtx;

    const source = txCtx.createMediaStreamSource(stream);
    const bufferSize = 2048; // ~42ms por bloco a 48kHz
    const processor = txCtx.createScriptProcessor(bufferSize, 2, 2);
    state.txProcessorNode = processor;

    processor.onaudioprocess = (e) => {
      if (!state.isBroadcasting || !state.wsConnected) return;
      if (state.transportMode === 'webrtc') return; // Modo apenas WebRTC

      const inputL = e.inputBuffer.getChannelData(0);
      const inputR = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : inputL;
      const len = inputL.length;

      // Cabeçalho de 8 bytes + len * 2 canais * 2 bytes (Int16)
      const packet = new ArrayBuffer(8 + len * 4);
      const view = new DataView(packet);
      view.setUint16(0, state.myNumericId & 0xffff, false);
      view.setUint16(2, state.txSeq++ & 0xffff, false);
      view.setUint16(4, Math.round(txCtx.sampleRate / 100), false);
      view.setUint8(6, 2); // 2 canais (estéreo)
      view.setUint8(7, 0);

      const pcm16 = new Int16Array(packet, 8);
      for (let i = 0; i < len; i++) {
        const sL = Math.max(-1, Math.min(1, inputL[i]));
        const sR = Math.max(-1, Math.min(1, inputR[i]));
        pcm16[i * 2] = sL < 0 ? sL * 0x8000 : sL * 0x7fff;
        pcm16[i * 2 + 1] = sR < 0 ? sR * 0x8000 : sR * 0x7fff;
      }

      if (state.ws && state.ws.readyState === WebSocket.OPEN && state.ws.bufferedAmount < 262144) {
        state.ws.send(packet);
      }
    };

    const muteSink = txCtx.createGain();
    muteSink.gain.value = 0;
    source.connect(processor);
    processor.connect(muteSink);
    muteSink.connect(txCtx.destination);
  }

  function stopBroadcasting() {
    state.isBroadcasting = false;
    stopPeerJsBroadcastToRoom();

    if (state.txSynthCleanup) {
      state.txSynthCleanup();
      state.txSynthCleanup = null;
    }

    if (state.txProcessorNode) {
      try {
        state.txProcessorNode.disconnect();
      } catch (_) {}
      state.txProcessorNode = null;
    }

    if (state.txAudioCtx) {
      try {
        state.txAudioCtx.close();
      } catch (_) {}
      state.txAudioCtx = null;
    }

    if (state.localCaptureStream) {
      state.localCaptureStream.getTracks().forEach((t) => t.stop());
      state.localCaptureStream = null;
    }

    for (const peerId of state.outboundPeers.keys()) {
      closeOutboundPeer(peerId);
    }

    sendSignaling({
      type: 'stream-state',
      isStreaming: false,
      sourceLabel: 'Parado'
    });

    updateBroadcastUI(false);
  }

  function updateBroadcastUI(active, label = '') {
    if (active) {
      dom.txLiveLed.className = 'led-indicator streaming';
      dom.txLiveStatus.textContent = `Transmitindo: ${label}`;
      dom.btnToggleBroadcast.textContent = '⏹ Parar Transmissão Deste Aparelho';
      dom.btnToggleBroadcast.className = 'btn btn-coral';
    } else {
      dom.txLiveLed.className = 'led-indicator';
      dom.txLiveStatus.textContent = 'Parado';
      dom.btnToggleBroadcast.textContent = '📡 Iniciar Transmissão Deste Aparelho';
      dom.btnToggleBroadcast.className = 'btn btn-amber';
    }
  }

  // Gerador Musical Estéreo para testar a transmissão em 1 clique sem precisar compartilhar tela
  function createLiveStereoSynthStream() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContextClass({ sampleRate: 48000 });
    const dest = ctx.createMediaStreamDestination();

    const master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(dest);

    const chordNotes = [220, 277.18, 329.63, 415.3, 493.88];
    let step = 0;

    const timer = setInterval(() => {
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      const pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;

      osc.type = step % 2 === 0 ? 'triangle' : 'sine';
      osc.frequency.value = chordNotes[step % chordNotes.length] * (step % 8 === 7 ? 1.5 : 1);

      env.gain.setValueAtTime(0.001, now);
      env.gain.exponentialRampToValueAtTime(0.28, now + 0.025);
      env.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

      if (pan) {
        pan.pan.value = Math.sin(step * 0.9) * 0.65;
        osc.connect(env);
        env.connect(pan);
        pan.connect(master);
      } else {
        osc.connect(env);
        env.connect(master);
      }

      osc.start(now);
      osc.stop(now + 0.28);
      step++;
    }, 220);

    return {
      stream: dest.stream,
      cleanup: () => {
        clearInterval(timer);
        try {
          ctx.close();
        } catch (_) {}
      }
    };
  }

  // ==========================================================================
  // 8. SIMULADOR DE 3 APARELHOS NA REDE (PARA TESTAR O MIXER IMEDIATAMENTE)
  // ==========================================================================

  function toggleMultiDeviceSimulation() {
    ensureAudioEngine(true);

    if (state.simActive) {
      stopMultiDeviceSimulation();
      return;
    }

    state.simActive = true;
    dom.btnSimulateDevices.textContent = '⏹ Parar Simulação (3 Aparelhos)';
    dom.btnSimulateDevices.classList.add('btn-coral');

    const ctx = state.audioCtx;

    // Aparelho 1: PC Windows (Jogos & YouTube)
    const chPc = getOrCreateMixerChannel('sim_pc_windows', {
      name: 'PC Windows (YouTube & Jogos)',
      deviceType: 'windows',
      sourceLabel: 'Áudio do Sistema (WASAPI)',
      transportLabel: 'Simulação Estéreo',
      isSimulated: true
    });
    chPc.pan = -0.25;
    if (chPc.pannerNode && chPc.pannerNode.pan) chPc.pannerNode.pan.value = -0.25;

    // Aparelho 2: Notebook Trabalho (Com Prioridade Auto-Ducking!)
    const chNote = getOrCreateMixerChannel('sim_notebook', {
      name: 'Notebook Trabalho (Chamada Voz)',
      deviceType: 'notebook',
      sourceLabel: 'Discord / Reunião (Com Prioridade)',
      transportLabel: 'Simulação Voz',
      isSimulated: true,
      priority: true
    });
    chNote.pan = 0;

    // Aparelho 3: Smart TV / Android (Música Ambiente)
    const chTv = getOrCreateMixerChannel('sim_android_tv', {
      name: 'Celular Android / TV (Spotify)',
      deviceType: 'android',
      sourceLabel: 'Lo-Fi Groove Estéreo',
      transportLabel: 'Simulação LAN',
      isSimulated: true
    });
    chTv.pan = 0.25;
    if (chTv.pannerNode && chTv.pannerNode.pan) chTv.pannerNode.pan.value = 0.25;

    renderMixerChannelsUI();

    // Loop musical 1: PC Windows (Arpejo Synth)
    const pcScale = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63];
    let pcIdx = 0;
    const t1 = setInterval(() => {
      if (!state.simActive || ctx.state !== 'running') return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = pcScale[pcIdx++ % pcScale.length];
      g.gain.setValueAtTime(0.001, now);
      g.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.connect(g);
      g.connect(chPc.inputNode);
      osc.start(now);
      osc.stop(now + 0.24);
    }, 250);

    // Loop 2: Notebook Trabalho (Fala periódica a cada 4 segundos para demonstrar o Auto-Ducking!)
    let voiceTick = 0;
    const t2 = setInterval(() => {
      if (!state.simActive || ctx.state !== 'running') return;
      voiceTick++;
      // Fala durante 6 pulsos e fica em silêncio por 8 pulsos (para você ouvir os outros canais subindo e descendo!)
      if (voiceTick % 14 < 6) {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const formant = ctx.createBiquadFilter();
        const g = ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.value = 175 + ((voiceTick * 23) % 60);
        formant.type = 'bandpass';
        formant.frequency.value = 950;
        formant.Q.value = 2.5;

        g.gain.setValueAtTime(0.001, now);
        g.gain.exponentialRampToValueAtTime(0.38, now + 0.03);
        g.gain.exponentialRampToValueAtTime(0.002, now + 0.24);

        osc.connect(formant);
        formant.connect(g);
        g.connect(chNote.inputNode);
        osc.start(now);
        osc.stop(now + 0.25);
      }
    }, 300);

    // Loop 3: Android / TV (Grave Lo-Fi pulsante)
    const bassNotes = [110, 110, 130.81, 98.0];
    let bIdx = 0;
    const t3 = setInterval(() => {
      if (!state.simActive || ctx.state !== 'running') return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(bassNotes[bIdx++ % bassNotes.length], now);
      g.gain.setValueAtTime(0.001, now);
      g.gain.exponentialRampToValueAtTime(0.32, now + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
      osc.connect(g);
      g.connect(chTv.inputNode);
      osc.start(now);
      osc.stop(now + 0.45);
    }, 500);

    state.simTimerIds.push(t1, t2, t3);
  }

  function stopMultiDeviceSimulation() {
    state.simActive = false;
    state.simTimerIds.forEach((id) => clearInterval(id));
    state.simTimerIds = [];

    removeMixerChannel('sim_pc_windows');
    removeMixerChannel('sim_notebook');
    removeMixerChannel('sim_android_tv');

    dom.btnSimulateDevices.textContent = '⚡ Simular 3 Aparelhos no Mixer';
    dom.btnSimulateDevices.classList.remove('btn-coral');
  }

  // ==========================================================================
  // 9. MEDIDORES VU EM TEMPO REAL, ESPECTRO MASTER & AUTO-DUCKING
  // ==========================================================================

  function startRealtimeMetersLoop() {
    const canvas = dom.masterSpectrumCanvas;
    const cctx = canvas ? canvas.getContext('2d') : null;
    let freqData = null;

    function tick() {
      requestAnimationFrame(tick);

      if (!state.audioCtx) return;

      let prioritySpeaking = false;

      // 1. Atualiza RMS e VU Meter de cada canal
      for (const ch of state.mixerChannels.values()) {
        let localRms = 0;
        if (state.audioCtx.state === 'running') {
          ch.analyser.getFloatTimeDomainData(ch.timeData);
          let sum = 0;
          for (let i = 0; i < ch.timeData.length; i++) {
            const s = ch.timeData[i];
            sum += s * s;
          }
          localRms = Math.sqrt(sum / ch.timeData.length);
        }
        ch.remoteRms = (ch.remoteRms || 0) * 0.88;
        const effectiveRemote = ch.muted ? 0 : ch.remoteRms * ch.volume;
        const rms = Math.max(localRms, effectiveRemote);
        ch.currentRms = rms;

        if (ch.priority && !ch.muted && rms > 0.025) {
          prioritySpeaking = true;
        }

        // Atualiza os 18 LEDs do VU Meter do canal
        const vuBar = document.getElementById(`vu-bar-${ch.id}`);
        if (vuBar) {
          const level = Math.min(1, Math.pow(rms * 3.6, 0.65));
          const activeSegs = Math.round(level * 18);
          const segNodes = vuBar.children;
          for (let i = 0; i < segNodes.length; i++) {
            if (i < activeSegs) {
              if (i < 12) segNodes[i].className = 'vu-seg on-green';
              else if (i < 16) segNodes[i].className = 'vu-seg on-amber';
              else segNodes[i].className = 'vu-seg on-red';
            } else {
              segNodes[i].className = 'vu-seg';
            }
          }
        }

        const card = document.getElementById(`ch-card-${ch.id}`);
        if (card) {
          card.classList.toggle('is-active-stream', rms > 0.008);
        }
      }

      // 2. Aplica Auto-Ducking (abaixa canais secundários quando um canal Prioritário está ativo)
      const now = state.audioCtx.currentTime;
      let duckChanged = false;
      for (const ch of state.mixerChannels.values()) {
        const shouldDuck = state.autoDucking && prioritySpeaking && !ch.priority;
        if (shouldDuck !== ch.isCurrentlyDucked) {
          ch.isCurrentlyDucked = shouldDuck;
          duckChanged = true;
          ch.duckingGain.gain.setTargetAtTime(shouldDuck ? 0.25 : 1.0, now, shouldDuck ? 0.04 : 0.28);
          const card = document.getElementById(`ch-card-${ch.id}`);
          if (card) card.classList.toggle('is-ducked', shouldDuck);
        }
      }
      if (duckChanged) {
        applyChannelGains();
      }

      // 3. Desenha Espectro Master e dB
      if (state.masterAnalyser && cctx && canvas) {
        if (!freqData) {
          freqData = new Uint8Array(state.masterAnalyser.frequencyBinCount);
        }
        state.masterAnalyser.getByteFrequencyData(freqData);

        const w = canvas.width;
        const h = canvas.height;
        cctx.clearRect(0, 0, w, h);

        const bars = 32;
        const barW = Math.floor((w - (bars - 1) * 3) / bars);
        let peakVal = 0;

        for (let i = 0; i < bars; i++) {
          const val = freqData[i] || 0;
          if (val > peakVal) peakVal = val;
          const pct = val / 255;
          const barH = Math.max(2, Math.round(pct * (h - 8)));
          const x = i * (barW + 3);
          const y = h - barH;

          if (pct > 0.85) {
            cctx.fillStyle = '#eb5146';
          } else if (pct > 0.62) {
            cctx.fillStyle = '#f8a522';
          } else {
            cctx.fillStyle = '#1dd177';
          }

          cctx.fillRect(x, y, barW, barH);
        }

        if (peakVal < 3) {
          dom.masterDbReadout.textContent = '-∞ dB';
        } else {
          const db = (20 * Math.log10(peakVal / 255)).toFixed(1);
          dom.masterDbReadout.textContent = `${db} dB`;
        }
      }
    }

    requestAnimationFrame(tick);
  }

  // ==========================================================================
  // 10. CONEXÃO WEBSOCKET E SINCRONIZAÇÃO DE DISPOSITIVOS NA REDE LOCAL
  // ==========================================================================

  function connectWebSocket() {
    if (!state.hasLocalLanServer) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.wsConnected = true;
      dom.wsStatusLed.className = 'led-indicator online';
      dom.wsStatusText.textContent = `LAN + Sala ${state.roomCode}`;

      sendSignaling({
        type: 'register',
        name: state.deviceName,
        deviceType: state.deviceType,
        role: state.role,
        isStreaming: state.isBroadcasting,
        transportMode: state.transportMode
      });
    });

    ws.addEventListener('message', (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        handleIncomingBinaryPcm(ev.data);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }

      switch (msg.type) {
        case 'welcome': {
          state.myId = msg.clientId;
          state.myNumericId = msg.numericId;
          syncNetworkDevices(msg.devices || []);
          break;
        }

        case 'devices-update': {
          syncNetworkDevices(msg.devices || []);
          break;
        }

        case 'webrtc-offer': {
          handleIncomingWebRtcOffer(msg);
          break;
        }

        case 'webrtc-answer': {
          const pc = state.outboundPeers.get(msg.fromId);
          if (pc && msg.sdp) {
            pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).catch(() => {});
          }
          break;
        }

        case 'webrtc-ice': {
          const pcOut = state.outboundPeers.get(msg.fromId);
          const pcIn = state.inboundPeers.get(msg.fromId);
          const pc = pcIn || pcOut;
          if (pc && msg.candidate) {
            pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
          }
          break;
        }

        case 'webrtc-request-stream': {
          if (state.isBroadcasting && msg.fromId) {
            initiateWebRtcToReceiver(msg.fromId);
          }
          break;
        }

        case 'pong-latency': {
          const rtt = Math.max(1, Date.now() - msg.clientTs);
          state.pingMs = rtt;
          dom.pingReadout.textContent = `${rtt} ms`;
          break;
        }

        default:
          break;
      }
    });

    ws.addEventListener('close', () => {
      state.wsConnected = false;
      if (state.hasLocalLanServer) {
        dom.wsStatusLed.className = 'led-indicator error';
        dom.wsStatusText.textContent = 'Reconectando LAN...';
        setTimeout(connectWebSocket, 2200);
      }
    });
  }

  function sendSignaling(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
    }
  }

  function syncNetworkDevices(devicesArray) {
    const currentIds = new Set();
    state.networkDevices.clear();

    for (const dev of devicesArray) {
      state.networkDevices.set(dev.id, dev);
      currentIds.add(dev.id);

      if (dev.id !== state.myId && dev.isStreaming) {
        const existed = state.mixerChannels.has(dev.id);
        getOrCreateMixerChannel(dev.id, {
          numericId: dev.numericId,
          name: dev.name,
          deviceType: dev.deviceType,
          sourceLabel: dev.sourceLabel || 'Áudio do Sistema',
          transportLabel: dev.transportMode === 'ws-pcm' ? 'WS PCM 16-bit' : 'Híbrido LAN'
        });

        if (!existed && !state.inboundPeers.has(dev.id)) {
          sendSignaling({
            type: 'webrtc-request-stream',
            targetId: dev.id
          });
        }
      } else if (dev.id !== state.myId && !dev.isStreaming) {
        if (state.mixerChannels.has(dev.id)) {
          removeMixerChannel(dev.id);
        }
      }
    }

    for (const [chId, ch] of state.mixerChannels.entries()) {
      if (!ch.isSimulated && !ch.isP2pCloud && !currentIds.has(chId)) {
        removeMixerChannel(chId);
      }
    }

    refreshCombinedNodesUI();
  }

  function refreshCombinedNodesUI() {
    const combined = [];
    if (state.networkDevices.size > 0) {
      for (const dev of state.networkDevices.values()) {
        combined.push(dev);
      }
    } else {
      combined.push({
        id: state.myId || 'me',
        name: state.deviceName,
        deviceType: state.deviceType,
        isStreaming: state.isBroadcasting,
        sourceLabel: state.isBroadcasting ? state.currentSourceLabel : `Sala P2P: ${state.roomCode}`
      });
    }

    for (const p2pDev of state.p2pPeersMeta.values()) {
      if (!combined.some((d) => d.id === p2pDev.id)) {
        combined.push(p2pDev);
      }
    }

    renderNetworkNodesList(combined);
  }

  function renderNetworkNodesList(devicesArray) {
    dom.connectedCount.textContent = String(devicesArray.length);
    dom.networkNodesContainer.innerHTML = devicesArray
      .map((dev) => {
        const isMe = dev.id === state.myId || dev.id === 'me';
        const badgeColor = dev.isStreaming ? 'var(--signal-amber)' : 'var(--signal-emerald)';
        const statusLabel = dev.isStreaming ? '📡 Transmitindo' : '🎧 Conectado';

        return `
          <div class="node-item">
            <div class="node-meta">
              <span>${getDeviceIcon(dev.deviceType)}</span>
              <div>
                <div class="node-name">
                  ${escapeHtml(dev.name)} ${isMe ? '<span style="color:var(--signal-amber); font-size:0.72rem;">(Você)</span>' : ''}
                </div>
                <div class="node-role">${escapeHtml(dev.sourceLabel || 'Pronto na sala')}</div>
              </div>
            </div>
            <span class="transport-pill" style="color:${badgeColor};">${statusLabel}</span>
          </div>
        `;
      })
      .join('');
  }

  // ==========================================================================
  // 10B. MODO P2P SEM SERVIDOR (PEERJS WEBRTC DIRETO PC <-> IPHONE)
  // Permite usar pelo GitHub Pages / Netlify sem instalar Node.js no Windows!
  // ==========================================================================

  const PEER_ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  function getRoomHubPeerId() {
    const clean = state.roomCode.toLowerCase().replace(/[^a-z0-9]/g, '');
    return `ondas-lan-hub-${clean || 'padrao'}`;
  }

  function ensurePeerJsReceiverHub() {
    if (typeof window.Peer === 'undefined') {
      setTimeout(ensurePeerJsReceiverHub, 450);
      return;
    }

    const desiredId = getRoomHubPeerId();
    if (state.rxPeer && !state.rxPeer.destroyed && state.rxPeer.id === desiredId) {
      return;
    }

    if (state.rxPeer) {
      try {
        state.rxPeer.destroy();
      } catch (_) {}
      state.rxPeer = null;
    }

    const peer = new window.Peer(desiredId, { config: PEER_ICE_CONFIG });
    state.rxPeer = peer;

    peer.on('open', () => {
      dom.wsStatusLed.className = 'led-indicator online';
      dom.wsStatusText.textContent = `Receptor P2P (${state.roomCode})`;
      refreshCombinedNodesUI();
    });

    peer.on('connection', (conn) => {
      const chId = `p2p_${conn.peer}`;
      conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'hello') {
          state.p2pPeersMeta.set(conn.peer, {
            id: conn.peer,
            name: data.name || 'PC Transmissor',
            deviceType: data.deviceType || 'windows',
            isStreaming: true,
            sourceLabel: data.sourceLabel || 'Áudio P2P Estéreo'
          });
          refreshCombinedNodesUI();
        } else if (data.type === 'vu' && typeof data.rms === 'number') {
          const ch = state.mixerChannels.get(chId);
          if (ch) {
            ch.remoteRms = data.rms;
          }
        } else if (data.type === 'ping') {
          conn.send({ type: 'pong', ts: data.ts });
        }
      });

      conn.on('close', () => {
        state.p2pPeersMeta.delete(conn.peer);
        removeMixerChannel(chId);
        refreshCombinedNodesUI();
      });
    });

    peer.on('call', (call) => {
      const meta = call.metadata || {};
      const chId = `p2p_${call.peer}`;

      call.answer(undefined, { sdpTransform: enhanceOpusSdp });

      call.on('stream', (remoteStream) => {
        const ch = getOrCreateMixerChannel(chId, {
          name: meta.name || 'PC Windows (P2P)',
          deviceType: meta.deviceType || 'windows',
          sourceLabel: meta.sourceLabel || 'Áudio do Sistema (WebRTC)',
          transportLabel: 'P2P Direto'
        });
        ch.isP2pCloud = true;
        attachRemoteWebRtcStreamToChannel(ch, remoteStream);

        state.p2pPeersMeta.set(call.peer, {
          id: call.peer,
          name: meta.name || 'PC Windows (P2P)',
          deviceType: meta.deviceType || 'windows',
          isStreaming: true,
          sourceLabel: meta.sourceLabel || 'Áudio do Sistema (WebRTC)'
        });
        refreshCombinedNodesUI();
      });

      call.on('close', () => {
        state.p2pPeersMeta.delete(call.peer);
        removeMixerChannel(chId);
        refreshCombinedNodesUI();
      });
    });

    peer.on('error', (err) => {
      if (err && err.type === 'unavailable-id') {
        if (!state.wsConnected) {
          dom.wsStatusLed.className = 'led-indicator online';
          dom.wsStatusText.textContent = `Sala P2P (${state.roomCode}) Pronta`;
        }
      }
    });
  }

  function startPeerJsBroadcastToRoom(stream, sourceLabel) {
    if (typeof window.Peer === 'undefined') {
      setTimeout(() => {
        if (state.isBroadcasting) startPeerJsBroadcastToRoom(stream, sourceLabel);
      }, 450);
      return;
    }
    stopPeerJsBroadcastToRoom();

    // Analisador leve no PC transmissor para enviar nível VU em tempo real ao iPhone via DataChannel
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const meterCtx = new AC();
      const src = meterCtx.createMediaStreamSource(stream);
      const an = meterCtx.createAnalyser();
      an.fftSize = 128;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      state.txVuMeterCtx = meterCtx;
      state.txVuInterval = setInterval(() => {
        if (!state.txDataConn || !state.txDataConn.open) return;
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const rms = Math.sqrt(s / buf.length);
        if (rms > 0.002) {
          state.txDataConn.send({ type: 'vu', rms: Number(rms.toFixed(4)) });
        }
      }, 90);
    } catch (_) {}

    const txPeer = new window.Peer(undefined, { config: PEER_ICE_CONFIG });
    state.txPeer = txPeer;

    const tryCallHub = () => {
      if (!state.isBroadcasting || !state.txPeer || state.txPeer.destroyed || !state.txPeer.open) return;
      if (state.txDataConn && state.txDataConn.open) {
        state.txDataConn.send({ type: 'ping', ts: Date.now() });
        return;
      }

      const hubId = getRoomHubPeerId();
      if (state.rxPeer && state.rxPeer.id === hubId && state.rxPeer.open) {
        return;
      }

      const conn = state.txPeer.connect(hubId, { reliable: true });
      state.txDataConn = conn;

      conn.on('open', () => {
        conn.send({
          type: 'hello',
          name: state.deviceName,
          deviceType: state.deviceType,
          sourceLabel
        });
        dom.wsStatusLed.className = 'led-indicator streaming';
        dom.wsStatusText.textContent = `Enviando p/ Sala ${state.roomCode}`;
      });

      conn.on('data', (msg) => {
        if (msg && msg.type === 'pong' && msg.ts) {
          dom.pingReadout.textContent = `${Math.max(1, Date.now() - msg.ts)} ms`;
        }
      });

      const call = state.txPeer.call(hubId, stream, {
        metadata: {
          name: state.deviceName,
          deviceType: state.deviceType,
          sourceLabel
        },
        sdpTransform: enhanceOpusSdp
      });
      state.txMediaCall = call;
    };

    txPeer.on('open', () => {
      tryCallHub();
      state.txRetryTimer = setInterval(tryCallHub, 3000);
    });

    txPeer.on('error', () => {
      // Receptor (iPhone) pode ainda não ter aberto a sala; o timer de 3s reconecta assim que abrir!
    });
  }

  function stopPeerJsBroadcastToRoom() {
    if (state.txVuInterval) {
      clearInterval(state.txVuInterval);
      state.txVuInterval = null;
    }
    if (state.txVuMeterCtx) {
      try {
        state.txVuMeterCtx.close();
      } catch (_) {}
      state.txVuMeterCtx = null;
    }
    if (state.txRetryTimer) {
      clearInterval(state.txRetryTimer);
      state.txRetryTimer = null;
    }
    if (state.txMediaCall) {
      try {
        state.txMediaCall.close();
      } catch (_) {}
      state.txMediaCall = null;
    }
    if (state.txDataConn) {
      try {
        state.txDataConn.close();
      } catch (_) {}
      state.txDataConn = null;
    }
    if (state.txPeer) {
      try {
        state.txPeer.destroy();
      } catch (_) {}
      state.txPeer = null;
    }
  }

  // ==========================================================================
  // 11. DESCOBERTA DE IP DA REDE LOCAL & QR CODE PARA O IPHONE
  // ==========================================================================

  async function loadNetworkInfoAndQr() {
    try {
      const res = await fetch('./api/network-info');
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('application/json')) {
        throw new Error('Modo estático / GitHub Pages');
      }

      const info = await res.json();
      state.hasLocalLanServer = true;
      connectWebSocket();

      const interfaces = info.interfaces || [];
      if (interfaces.length > 0) {
        if (dom.ipInterfaceWrap) dom.ipInterfaceWrap.classList.remove('hidden');
        dom.selectLanIp.innerHTML = interfaces
          .map(
            (iface) =>
              `<option value="${iface.address}:${info.port}">${iface.address} (${iface.name})</option>`
          )
          .join('');
        updateQrCodeForLanHost(dom.selectLanIp.value);
        dom.selectLanIp.addEventListener('change', () => {
          updateQrCodeForLanHost(dom.selectLanIp.value);
        });
      } else {
        if (dom.ipInterfaceWrap) dom.ipInterfaceWrap.classList.add('hidden');
        updateQrCodeForWebRoom();
      }
    } catch (_) {
      // Hospedado estaticamente (GitHub Pages / Netlify / Cloudflare) -> Modo P2P Puro!
      state.hasLocalLanServer = false;
      if (dom.ipInterfaceWrap) dom.ipInterfaceWrap.classList.add('hidden');
      dom.wsStatusLed.className = 'led-indicator online';
      dom.wsStatusText.textContent = `Modo Web P2P (${state.roomCode})`;
      updateQrCodeForWebRoom();
      refreshCombinedNodesUI();
    }
  }

  function updateQrCodeForLanHost(hostWithPort) {
    const url = `http://${hostWithPort}/?room=${encodeURIComponent(state.roomCode)}&role=receiver`;
    renderQrTargetUrl(url);
  }

  function updateQrCodeForWebRoom() {
    const base = `${window.location.origin}${window.location.pathname}`;
    const url = `${base}?room=${encodeURIComponent(state.roomCode)}&role=receiver`;
    renderQrTargetUrl(url);
  }

  function renderQrTargetUrl(url) {
    dom.lanReceiverUrl.textContent = url;
    if (window.OndasQR) {
      dom.qrCodeContainer.innerHTML = window.OndasQR.renderQrSvg(url, {
        margin: 2
      });
    }
  }

  function applyNewRoomCode(rawCode) {
    const cleaned = String(rawCode || '')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .toUpperCase()
      .slice(0, 12);
    if (!cleaned) return;
    state.roomCode = cleaned;
    localStorage.setItem('ondas_room_code', cleaned);
    if (dom.inputRoomCode) dom.inputRoomCode.value = cleaned;

    if (state.hasLocalLanServer && dom.selectLanIp && dom.selectLanIp.value) {
      updateQrCodeForLanHost(dom.selectLanIp.value);
    } else {
      updateQrCodeForWebRoom();
    }

    if (state.role === 'receiver' || isIOS || isAndroid || state.audioUnlocked) {
      ensurePeerJsReceiverHub();
    }
    if (state.isBroadcasting && state.localCaptureStream) {
      startPeerJsBroadcastToRoom(state.localCaptureStream, state.currentSourceLabel);
    }
    refreshCombinedNodesUI();
  }

  // ==========================================================================
  // 12. EVENTOS DE INTERFACE E INICIALIZAÇÃO
  // ==========================================================================

  function setRoleMode(mode) {
    state.role = mode;
    dom.modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    if (mode === 'receiver') {
      dom.receiverSection.classList.remove('hidden');
      dom.senderSection.classList.add('hidden');
      ensurePeerJsReceiverHub();
    } else if (mode === 'sender') {
      dom.receiverSection.classList.add('hidden');
      dom.senderSection.classList.remove('hidden');
      if (state.rxPeer) {
        try {
          state.rxPeer.destroy();
        } catch (_) {}
        state.rxPeer = null;
      }
    } else {
      dom.receiverSection.classList.remove('hidden');
      dom.senderSection.classList.remove('hidden');
    }

    sendSignaling({
      type: 'register',
      role: state.role
    });
  }

  function updateMasterGainUI() {
    const pct = Math.round(state.masterVolume * 100);
    dom.masterVolumeFader.value = String(pct);
    dom.masterVolumeBadge.textContent = state.masterMuted ? 'MUTE' : `${pct}%`;
    dom.btnMuteMaster.textContent = state.masterMuted ? '🔇 Master Mutado' : '🔊 Master Ativo';
    dom.btnMuteMaster.classList.toggle('btn-coral', state.masterMuted);

    if (state.masterGainNode && state.audioCtx) {
      const target = state.masterMuted ? 0 : state.masterVolume;
      state.masterGainNode.gain.setTargetAtTime(target, state.audioCtx.currentTime, 0.015);
    }
    applyChannelGains();
  }

  async function populateAudioInputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      if (inputs.length === 0) {
        dom.selectAudioInput.innerHTML = `<option value="">Entrada Padrão do Sistema</option>`;
        return;
      }
      dom.selectAudioInput.innerHTML = inputs
        .map((d, idx) => `<option value="${d.deviceId}">${escapeHtml(d.label || `Entrada de Áudio #${idx + 1}`)}</option>`)
        .join('');
    } catch (_) {}
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function initApp() {
    dom.inputDeviceName.value = state.deviceName;
    if (dom.inputRoomCode) dom.inputRoomCode.value = state.roomCode;
    dom.subtitle.textContent = `${state.deviceName} • Sala ${state.roomCode}`;

    // Verifica parâmetro ?role=receiver vindo do QR Code escaneado pelo iPhone
    const params = new URLSearchParams(window.location.search);
    const roleParam = params.get('role');
    if (roleParam === 'receiver' || isIOS || isAndroid) {
      setRoleMode(roleParam === 'receiver' ? 'receiver' : 'both');
      ensurePeerJsReceiverHub();
    }

    // Seletor de Modo (Estúdio Completo / Ouvir / Transmitir)
    dom.modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        setRoleMode(btn.dataset.mode);
      });
    });

    // Ativar Áudio & 2º Plano no iPhone/Android (também ativa o Hub Receptor P2P desta sala!)
    dom.btnActivateAudio.addEventListener('click', () => {
      unlockMobileBackgroundAudio();
      ensurePeerJsReceiverHub();
    });

    // Trocar Código da Sala P2P
    if (dom.btnApplyRoom && dom.inputRoomCode) {
      dom.btnApplyRoom.addEventListener('click', () => {
        applyNewRoomCode(dom.inputRoomCode.value);
      });
      dom.inputRoomCode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') applyNewRoomCode(dom.inputRoomCode.value);
      });
    }

    // Simular 3 Aparelhos no Mixer
    dom.btnSimulateDevices.addEventListener('click', () => {
      toggleMultiDeviceSimulation();
    });

    // Master Volume & Mute
    dom.masterVolumeFader.addEventListener('input', (e) => {
      ensureAudioEngine(true);
      state.masterVolume = Number(e.target.value) / 100;
      state.masterMuted = false;
      updateMasterGainUI();
    });

    dom.btnMuteMaster.addEventListener('click', () => {
      ensureAudioEngine(true);
      state.masterMuted = !state.masterMuted;
      updateMasterGainUI();
    });

    dom.btnResetLevels.addEventListener('click', () => {
      ensureAudioEngine(true);
      for (const ch of state.mixerChannels.values()) {
        ch.volume = 1.0;
        ch.pan = 0;
        ch.bassDb = 0;
        ch.trebleDb = 0;
        ch.muted = false;
        ch.solo = false;
        ch.bassFilter.gain.value = 0;
        ch.trebleFilter.gain.value = 0;
        if (ch.pannerNode && ch.pannerNode.pan) ch.pannerNode.pan.value = 0;
      }
      applyChannelGains();
      renderMixerChannelsUI();
    });

    dom.chkAutoDucking.addEventListener('change', (e) => {
      state.autoDucking = e.target.checked;
    });

    dom.selectJitterBuffer.addEventListener('change', (e) => {
      state.jitterBufferSec = Number(e.target.value) || 0.045;
    });

    // Seleção de Fonte de Captura (Sistema Windows / Microfone / Gerador Musical)
    dom.sourceCards.forEach((card) => {
      card.addEventListener('click', () => {
        dom.sourceCards.forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        state.selectedSource = card.dataset.source;

        dom.windowsGuide.classList.toggle('hidden', state.selectedSource !== 'system');
        dom.micSelectorBox.classList.toggle('hidden', state.selectedSource !== 'mic');

        if (state.selectedSource === 'mic') {
          populateAudioInputs();
        }
      });
    });

    // Nome do aparelho
    dom.inputDeviceName.addEventListener('change', (e) => {
      const val = e.target.value.trim() || detectDefaultDeviceName();
      state.deviceName = val;
      localStorage.setItem('ondas_device_name', val);
      dom.subtitle.textContent = `${val} • Sala ${state.roomCode}`;
      sendSignaling({
        type: 'register',
        name: val
      });
    });

    dom.selectTransportMode.addEventListener('change', (e) => {
      state.transportMode = e.target.value;
    });

    dom.btnToggleBroadcast.addEventListener('click', () => {
      startBroadcasting();
    });

    dom.btnCopyLanUrl.addEventListener('click', () => {
      const text = dom.lanReceiverUrl.textContent;
      navigator.clipboard.writeText(text).then(() => {
        dom.btnCopyLanUrl.textContent = 'Copiado!';
        setTimeout(() => {
          dom.btnCopyLanUrl.textContent = 'Copiar';
        }, 1500);
      });
    });

    // Ping periódico para medir latência de rede local
    setInterval(() => {
      if (state.wsConnected) {
        sendSignaling({
          type: 'ping-latency',
          clientTs: Date.now()
        });
      }
    }, 2500);

    renderMixerChannelsUI();
    loadNetworkInfoAndQr();
    startRealtimeMetersLoop();
  }

  document.addEventListener('DOMContentLoaded', initApp);
})();
