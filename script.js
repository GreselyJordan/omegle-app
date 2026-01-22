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

const statusMsg = document.getElementById('status-msg');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const chatSection = document.getElementById('chat-section');
const chatWindow = document.getElementById('chat-window');
const msgInput = document.getElementById('msg-input');
const tvOverlay = document.getElementById('tv-overlay');
const debugLog = document.getElementById('debug-log');

// Helper for "Typing" effect on status
function updateStatus(text) {
    statusMsg.innerText = text.toUpperCase();
    // Optional: Add a glitch effect class temporarily here if desired
}

function log(text) {
    console.log(text);
    debugLog.style.display = 'block';
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    debugLog.innerHTML += `[${time}] > ${text}<br>`;
    debugLog.scrollTop = debugLog.scrollHeight;
}

navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true })
    .then(stream => {
        localStream = stream;
        document.getElementById('local-video').srcObject = stream;
        iniciarPeer();
    })
    .catch(err => {
        updateStatus("ERROR: CAMERA ACCESS DENIED");
        log("CRITICAL: Camera access failed - " + err);
        btnStart.disabled = true;
    });

function iniciarPeer() {
    peer = new Peer(undefined, peerConfig);
    
    peer.on('open', (id) => { 
        updateStatus("SYSTEM ONLINE. READY.");
        log("NODE ID ASSIGNED: " + id);
    });
    
    peer.on('call', call => {
        log("INCOMING TRANSMISSION DETECTED");
        isSearching = false; 
        updateStatus("ESTABLISHING UPLINK...");
        gestionarLlamada(call);
    });

    peer.on('connection', conn => {
        log("DATA CHANNEL OPENED");
        gestionarChat(conn);
    });

    peer.on('error', err => {
        log("PEER ERROR: " + err.type);
        if(err.type === 'peer-unavailable' && isSearching) {
            setTimeout(buscarPareja, 2000);
        }
    });
}

async function buscarPareja() {
    if (!peer || !peer.id) return;
    
    isSearching = true; 
    tvOverlay.style.display = 'block'; 
    updateStatus("SCANNING NETWORK...");
    btnStart.disabled = true;
    btnStart.style.opacity = "0.7";
    log("INITIATING SEARCH PROTOCOL...");

    try {
        const response = await fetch(`https://${SERVER_URL}/myapp/peerjs/peers?ts=${Date.now()}`);
        const usuarios = await response.json();
        const extraños = usuarios.filter(id => id !== peer.id);

        if (extraños.length === 0) {
            updateStatus("NO SIGNALS DETECTED...");
            log("Network silent. Retrying scan...");
            setTimeout(() => {
                if(isSearching) buscarPareja(); 
            }, 3000);
            return;
        }

        log(`TARGETS IDENTIFIED: ${extraños.length}`);
        const randomId = extraños[Math.floor(Math.random() * extraños.length)];
        
        const randomDelay = Math.floor(Math.random() * 2000); 
        log(`SYNCING ENCRYPTION KEYS (${randomDelay}ms)...`);
        updateStatus("SYNCHRONIZING...");

        setTimeout(() => {
            if (!isSearching || currentCall) {
                log("ABORT: LINE BUSY");
                return;
            }

            log(`DIALING TARGET: ${randomId}`);
            const call = peer.call(randomId, localStream);
            const conn = peer.connect(randomId);
            
            gestionarLlamada(call);
            gestionarChat(conn);
        }, randomDelay);

    } catch (error) {
        log("NETWORK ERROR: " + error);
        setTimeout(buscarPareja, 3000);
    }
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
                if (error.name === 'AbortError') {
                    console.log("Autoplay handled.");
                } else {
                    log("AUTOPLAY ERROR: " + error);
                }
            });
        }

        tvOverlay.style.display = 'none';
        mostrarInterfazConectado();
    });
    
    call.on('error', err => log("CALL ERROR: " + err));
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
    div.innerText = texto; // Text is already styled by CSS font
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function mostrarInterfazConectado() {
    if(!isSearching) return; 
    isSearching = false; 
    btnStart.style.display = 'none';
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
    btnStop.style.display = 'none';
    chatSection.style.display = 'none';
    
    btnStart.disabled = false;
    btnStart.style.opacity = "1";
    log("SESSION ENDED.");
}
