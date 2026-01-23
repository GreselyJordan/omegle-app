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
let isConnected = false; // New flag to track active conversation
let isMicMuted = false;
let currentFacingMode = "user";

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

        // Strategy 1: Try preferred settings
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: facingMode }, 
                audio: true 
            });
            return handleSuccess(stream);
        } catch (err) {
            log("Preferred config failed. Trying fallback...");
        }

        // Strategy 2: Try basic settings (no facing mode)
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: true, 
                audio: true 
            });
            return handleSuccess(stream);
        } catch (err) {
            log("Basic config failed. Trying video only...");
        }

        // Strategy 3: Video only (maybe audio is blocked?)
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: true, 
                audio: false 
            });
            log("WARNING: Audio access denied/unavailable.");
            return handleSuccess(stream);
        } catch (err) {
            throw err; // All attempts failed
        }

    } catch (err) {
        log("CRITICAL MEDIA ERROR: " + err.name + " - " + err.message);
        updateStatus("CAMERA BLOCKED/NOT FOUND");
        
        if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
            alert("SECURITY ALERT: WebRTC requires HTTPS. Please use a secure connection.");
        } else {
            alert("Camera access failed. Please check browser permissions and ensure no other app is using the camera.");
        }
        return null;
    }
}

function handleSuccess(stream) {
    localStream = stream;
    document.getElementById('local-video').srcObject = stream;
    
    // Restore mute state if needed
    if (isMicMuted) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) audioTrack.enabled = false;
    }

    // If in a call, replace the track
    if (currentCall) {
        const videoTrack = stream.getVideoTracks()[0];
        const sender = currentCall.peerConnection.getSenders().find((s) => s.track.kind === videoTrack.kind);
        if (sender) {
            sender.replaceTrack(videoTrack);
        }
    }
    return stream;
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
        updateStatus("SYSTEM ONLINE. STANDBY.");
        log("NODE ID: " + id);
    });
    
    peer.on('call', call => {
        // CRITICAL FIX: Only answer if we are actively searching
        if (isSearching && !isConnected) {
            log("INCOMING TRANSMISSION...");
            updateStatus("ESTABLISHING UPLINK...");
            gestionarLlamada(call);
        } else {
            log(`IGNORED INCOMING (Searching: ${isSearching}, Connected: ${isConnected})`);
            call.close(); // Reject the call
        }
    });

    peer.on('connection', conn => {
        if (isSearching || isConnected) {
            log("DATA CHANNEL OPENED");
            gestionarChat(conn);
        } else {
            conn.close();
        }
    });

    peer.on('error', err => {
        log("PEER ERROR: " + err.type);
        if(err.type === 'peer-unavailable' && isSearching) {
            setTimeout(buscarPareja, 1000);
        }
    });
}

// --- SEARCH LOGIC ---

async function buscarPareja() {
    if (!peer || !peer.id) return;
    
    isSearching = true; 
    isConnected = false;
    tvOverlay.style.display = 'block'; 
    updateStatus("SCANNING NETWORK...");
    
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
        
        const randomId = extraños[Math.floor(Math.random() * extraños.length)];
        const randomDelay = Math.floor(Math.random() * 1000); 
        
        setTimeout(() => {
            if (!isSearching || isConnected) return; 

            log(`DIALING TARGET: ${randomId}`);
            const call = peer.call(randomId, localStream);
            const conn = peer.connect(randomId);
            
            // Timeout: If no connection in 5s, assume rejection/timeout and retry
            const callTimeout = setTimeout(() => {
                if (!isConnected && currentCall === call) {
                    log("NO ANSWER / TIMEOUT. RETRYING...");
                    call.close(); // This will trigger 'close' event
                }
            }, 5000);

            gestionarLlamada(call, callTimeout);
            gestionarChat(conn);

        }, randomDelay);

    } catch (error) {
        log("NETWORK ERROR: " + error);
        if (isSearching) setTimeout(buscarPareja, 3000);
    }
}

function cancelarBusqueda() {
    isSearching = false;
    isConnected = false;
    tvOverlay.style.display = 'none';
    updateStatus("SEARCH ABORTED");
    btnStart.style.display = 'block';
    btnCancel.style.display = 'none';
    btnStop.style.display = 'none';
    
    if (currentCall) currentCall.close();
    log("SEARCH CANCELLED BY USER");
}

function gestionarLlamada(call, timeoutId = null) {
    if (currentCall && currentCall.peer !== call.peer) {
        call.close();
        return;
    }

    currentCall = call;
    
    // Always answer, but the 'stream' event determines success
    call.answer(localStream);
    
    call.on('stream', remoteStream => {
        if (timeoutId) clearTimeout(timeoutId);
        
        // CRITICAL FIX: Check if we are still allowed to connect
        // If the user cancelled (isSearching == false) and we are not yet connected, ABORT.
        if (!isSearching && !isConnected) {
            log("STREAM RECEIVED BUT SEARCH CANCELLED. ABORTING.");
            call.close();
            return;
        }

        const videoElement = document.getElementById('remote-video');
        if (videoElement.srcObject === remoteStream) return;

        log("VIDEO FEED CAPTURED");
        videoElement.srcObject = remoteStream;
        
        isConnected = true; // Mark as successfully connected
        isSearching = false; // Stop searching

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
        if (timeoutId) clearTimeout(timeoutId);
    });
    
    call.on('close', () => {
        if (timeoutId) clearTimeout(timeoutId);
        
        if (isConnected) {
            // Was a valid call, now ended
            cortarLlamada();
        } else {
            // Was a failed attempt (rejected or timed out)
            log("CALL FAILED/REJECTED");
            currentCall = null;
            document.getElementById('remote-video').srcObject = null;
            // If we are still searching, try next
            if (isSearching) {
                buscarPareja();
            }
        }
    });
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
    isConnected = false;
    
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
