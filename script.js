const SERVER_URL = 'backend-omegle-17xd.onrender.com';

const peerConfig = {
    host: SERVER_URL,
    port: 443,
    path: '/myapp',
    secure: true,
    debug: 0,
    config: {
        iceServers: [
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ]
    }
};

let peer = null;
let localStream = null;
let currentCall = null;
let currentDataConn = null;
let isSearching = false;
let isMicMuted = false;
let currentFacingMode = "user"; // 'user' or 'environment'

const statusMsg = document.getElementById('status-msg');
const btnStart = document.getElementById('btn-start');
const btnCancel = document.getElementById('btn-cancel');
const btnStop = document.getElementById('btn-stop');
const chatSection = document.getElementById('chat-section');
const chatWindow = document.getElementById('chat-window');
const msgInput = document.getElementById('msg-input');
const tvOverlay = document.getElementById('tv-overlay');
const debugLog = document.getElementById('debug-log');
const micIcon = document.getElementById('mic-icon');

function updateStatus(text) {
    statusMsg.innerText = text.toUpperCase();
}

function log(text) {
    console.log(text);
    debugLog.style.display = 'block';
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    debugLog.innerHTML += `[${time}] > ${text}<br>`;
    debugLog.scrollTop = debugLog.scrollHeight;
}

// --- MEDIA CONTROLS ---

async function getMediaStream(facingMode = 'user') {
    try {
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: facingMode }, 
            audio: true 
        });
        localStream = stream;
        document.getElementById('local-video').srcObject = stream;
        
        // Restore mute state if needed
        if (isMicMuted) {
            localStream.getAudioTracks()[0].enabled = false;
        }

        // If in a call, replace the track (advanced, but for now we just restart call or keep local view)
        if (currentCall) {
            // PeerJS doesn't support easy track replacement in all browsers without renegotiation
            // For simplicity in this "hacky" app, we might need to just update local view 
            // OR ideally renegotiate. But renegotiation is hard in PeerJS v1.
            // Let's just warn user or try to replace track if supported.
            const videoTrack = stream.getVideoTracks()[0];
            const sender = currentCall.peerConnection.getSenders().find((s) => s.track.kind === videoTrack.kind);
            if (sender) {
                sender.replaceTrack(videoTrack);
            }
        }

        return stream;
    } catch (err) {
        log("MEDIA ERROR: " + err);
        updateStatus("CAMERA ERROR");
        return null;
    }
}

function switchCamera() {
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    log("SWITCHING CAMERA TO: " + currentFacingMode.toUpperCase());
    getMediaStream(currentFacingMode);
}

function toggleMic() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        isMicMuted = !isMicMuted;
        audioTrack.enabled = !isMicMuted;
        
        // Update Icon
        if (isMicMuted) {
            micIcon.innerHTML = '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><line x1="1" y1="1" x2="23" y2="23"></line><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line>';
            micIcon.style.stroke = "#ff0000";
            log("MICROPHONE MUTED");
        } else {
            micIcon.innerHTML = '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line>';
            micIcon.style.stroke = "currentColor";
            log("MICROPHONE ACTIVE");
        }
    }
}

// --- INITIALIZATION ---

getMediaStream('user').then(() => {
    iniciarPeer();
});

function iniciarPeer() {
    peer = new Peer(undefined, peerConfig);
    
    peer.on('open', (id) => { 
        updateStatus("SYSTEM ONLINE. READY.");
        log("NODE ID: " + id);
    });
    
    peer.on('call', call => {
        if (isSearching || !currentCall) {
            log("INCOMING TRANSMISSION...");
            isSearching = false; 
            updateStatus("ESTABLISHING UPLINK...");
            gestionarLlamada(call);
        } else {
            // Busy
            log("REJECTED INCOMING (BUSY)");
            call.close();
        }
    });

    peer.on('connection', conn => {
        log("DATA CHANNEL OPENED");
        gestionarChat(conn);
    });

    peer.on('error', err => {
        log("PEER ERROR: " + err.type);
        if(err.type === 'peer-unavailable' && isSearching) {
            // Retry immediately if peer not found
            setTimeout(buscarPareja, 1000);
        }
    });
}

// --- SEARCH LOGIC OPTIMIZED ---

async function buscarPareja() {
    if (!peer || !peer.id) return;
    
    isSearching = true; 
    tvOverlay.style.display = 'block'; 
    updateStatus("SCANNING NETWORK...");
    
    // UI Updates
    btnStart.style.display = 'none';
    btnCancel.style.display = 'block';
    btnStop.style.display = 'none';
    
    log("INITIATING SEARCH PROTOCOL...");

    try {
        const response = await fetch(`https://${SERVER_URL}/myapp/peerjs/peers?ts=${Date.now()}`);
        const usuarios = await response.json();
        const extraños = usuarios.filter(id => id !== peer.id);

        if (extraños.length === 0) {
            updateStatus("NO SIGNALS DETECTED...");
            log("Network silent. Retrying...");
            if (isSearching) setTimeout(buscarPareja, 2000);
            return;
        }

        log(`TARGETS IDENTIFIED: ${extraños.length}`);
        
        // OPTIMIZATION: Try a random user, but handle failure faster
        const randomId = extraños[Math.floor(Math.random() * extraños.length)];
        
        // Random delay to reduce collision probability
        const randomDelay = Math.floor(Math.random() * 1500); 
        log(`SYNCING (${randomDelay}ms)...`);
        
        setTimeout(() => {
            if (!isSearching) return; // Cancelled
            if (currentCall) return; // Already connected

            log(`DIALING TARGET: ${randomId}`);
            const call = peer.call(randomId, localStream);
            const conn = peer.connect(randomId);
            
            // Timeout to abort if no answer in 5s
            const callTimeout = setTimeout(() => {
                if (currentCall !== call) {
                    log("NO ANSWER. RETRYING...");
                    call.close();
                    if (isSearching) buscarPareja();
                }
            }, 8000);

            gestionarLlamada(call);
            gestionarChat(conn);
            
            // Clear timeout if connected
            call.on('stream', () => clearTimeout(callTimeout));
            call.on('close', () => clearTimeout(callTimeout));
            call.on('error', () => {
                clearTimeout(callTimeout);
                if (isSearching) buscarPareja();
            });

        }, randomDelay);

    } catch (error) {
        log("NETWORK ERROR: " + error);
        if (isSearching) setTimeout(buscarPareja, 3000);
    }
}

function cancelarBusqueda() {
    isSearching = false;
    tvOverlay.style.display = 'none';
    updateStatus("SEARCH ABORTED");
    btnStart.style.display = 'block';
    btnCancel.style.display = 'none';
    btnStop.style.display = 'none';
    log("SEARCH CANCELLED BY USER");
}

function gestionarLlamada(call) {
    if (currentCall && currentCall.peer !== call.peer) {
        call.close();
        return;
    }

    currentCall = call;
    
    call.answer(localStream);
    
    call.on('stream', remoteStream => {
        const videoElement = document.getElementById('remote-video');
        if (videoElement.srcObject === remoteStream) return;

        log("VIDEO FEED CAPTURED");
        videoElement.srcObject = remoteStream;
        
        const playPromise = videoElement.play();
        if (playPromise !== undefined) {
            playPromise.catch(error => {
                if (error.name !== 'AbortError') log("AUTOPLAY ERROR: " + error);
            });
        }

        tvOverlay.style.display = 'none';
        mostrarInterfazConectado();
    });
    
    call.on('error', err => {
        log("CALL ERROR: " + err);
        if (isSearching) buscarPareja(); // Retry if error during setup
    });
    
    call.on('close', cortarLlamada);
}

function gestionarChat(conn) {
    currentDataConn = conn;
    conn.on('open', () => { 
        chatWindow.innerHTML = ''; 
        log("SECURE CHAT INITIALIZED");
    });
    conn.on('data', data => { agregarMensaje(data, 'them'); });
}

function enviarMensaje() {
    const texto = msgInput.value.trim();
    if (!texto || !currentDataConn) return;
    currentDataConn.send(texto);
    agregarMensaje(texto, 'me');
    msgInput.value = '';
}

function agregarMensaje(texto, tipo) {
    const div = document.createElement('div');
    div.className = `msg msg-${tipo}`;
    div.innerText = texto;
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function mostrarInterfazConectado() {
    isSearching = false; 
    btnStart.style.display = 'none';
    btnCancel.style.display = 'none';
    btnStop.style.display = 'block';
    chatSection.style.display = 'flex';
    updateStatus("SECURE CONNECTION ESTABLISHED");
    log("UPLINK SUCCESSFUL.");
    setTimeout(() => { chatSection.scrollIntoView({ behavior: 'smooth' }); }, 500);
}

function cortarLlamada() {
    isSearching = false;
    if (currentCall) currentCall.close();
    if (currentDataConn) currentDataConn.close();
    
    currentCall = null;
    currentDataConn = null;
    document.getElementById('remote-video').srcObject = null;
    
    tvOverlay.style.display = 'none';
    updateStatus("CONNECTION TERMINATED");
    
    btnStart.style.display = 'block';
    btnCancel.style.display = 'none';
    btnStop.style.display = 'none';
    chatSection.style.display = 'none';
    
    log("SESSION ENDED.");
}
