const socket = io();
let myName = null;
let isEliminated = false;

// Elementos DOM cacheados para rendimiento
const els = {
    join: document.getElementById('joinScreen'),
    game: document.getElementById('gameScreen'),
    welcome: document.getElementById('welcomeScreen'),
    timesUp: document.getElementById('timesUpScreen'),
    eliminated: document.getElementById('eliminatedScreen'),
    winner: document.getElementById('winnerScreen'),
    voting: document.getElementById('votingPanel'),
    timer: document.getElementById('timerDisplay'),
    round: document.getElementById('roundDisplay'),
    bankBtn: document.getElementById('bankBtn'),
    ladder: document.getElementById('ladderDisplay'),
    totalBank: document.getElementById('totalBankDisplay'),
    currentChain: document.getElementById('currentChainDisplay'),
    finalBoard: document.getElementById('finalBoard'),
    financePanel: document.getElementById('financePanel')
};

// --- SONIDOS Y HAPTICS ---
const vibrate = (pattern) => {
    if (navigator.vibrate) navigator.vibrate(pattern);
};

// --- JOIN ---
window.joinGame = () => {
    const input = document.getElementById('nameInput');
    if (!input.value.trim()) return;
    
    myName = input.value.trim().toUpperCase();
    socket.emit('registerPlayer', myName);
    
    els.join.classList.add('hidden');
    els.welcome.classList.remove('hidden');
    document.getElementById('welcomeMsg').textContent = `Bienvenido, ${myName}`;
    
    // Entrar a pantalla completa (opcional, ayuda en Android)
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(()=>{});
};

window.doBank = () => {
    socket.emit('bank');
    vibrate(50); // Feedback táctil corto
};

// --- SOCKET EVENTS ---

socket.on("gameReset", () => location.reload());

socket.on("phaseChanged", (phase) => {
    // Resetear vistas
    Object.values(els).forEach(el => {
        if(el.classList.contains('overlay')) el.classList.add('hidden');
    });
    els.voting.classList.remove('show');
    
    // Lógica por Fase
    if (phase === "questions") {
        if (!isEliminated) {
            els.welcome.classList.add('hidden');
            els.game.classList.remove('hidden');
            els.finalBoard.classList.add('hidden');
            els.financePanel.classList.remove('hidden');
            els.bankBtn.classList.remove('hidden');
        }
    } 
    else if (phase === "times_up") {
        els.timesUp.classList.remove('hidden');
        vibrate([200, 100, 200]);
    }
    else if (phase === "voting") {
        if (!isEliminated) {
            els.game.classList.remove('hidden');
            els.voting.classList.add('show');
            vibrate(100);
        }
    }
    else if (phase === "elimination") {
        // En esta fase solo mostramos la pantalla roja si fuiste tú, 
        // o esperamos al evento 'playerEliminated'
    }
    else if (phase === "final" || phase === "final_intro") {
        els.welcome.classList.add('hidden');
        els.game.classList.remove('hidden');
        els.financePanel.classList.add('hidden'); // No hay dinero en final
        els.bankBtn.classList.add('hidden');
        els.finalBoard.classList.remove('hidden');
    }
    else if (phase === "final_result") {
        els.winner.classList.remove('hidden');
    }
});

socket.on("timerUpdate", (time) => {
    els.timer.textContent = time;
    if (time <= 5) {
        els.timer.className = 'timer-danger';
        vibrate(50); // Tic tac táctil
    } else if (time <= 10) {
        els.timer.className = 'timer-warn';
    } else {
        els.timer.className = '';
    }
});

socket.on("bankState", (state) => {
    // Actualizar texto
    els.totalBank.textContent = `$${state.bankedTotal}`;
    els.currentChain.textContent = `$${state.currentChainValue}`;
    
    // Renderizar Escalera
    els.ladder.innerHTML = '';
    [...state.chain].reverse().forEach((val, idx) => { // Invertimos para dibujar de arriba a abajo visualmente
        const realIdx = state.chain.length - 1 - idx;
        const div = document.createElement('div');
        div.className = `ladder-step ${realIdx === state.chainIndex ? 'active' : ''} ${realIdx < state.chainIndex ? 'passed' : ''}`;
        div.textContent = `$${val}`;
        els.ladder.appendChild(div);
    });

    // Activar botón de banca si hay dinero
    if (state.currentChainValue > 0) {
        els.bankBtn.classList.add('active');
    } else {
        els.bankBtn.classList.remove('active');
    }
});

socket.on("playersUpdated", (players) => {
    const container = els.voting;
    // Limpiar botones viejos (manteniendo el título)
    while (container.childNodes.length > 2) {
        container.removeChild(container.lastChild);
    }
    
    players.forEach(p => {
        if (p !== myName) {
            const btn = document.createElement('button');
            btn.className = 'vote-item';
            btn.textContent = p;
            btn.onclick = () => {
                socket.emit('vote', p);
                vibrate(50);
                els.voting.classList.remove('show'); // Ocultar al votar
                // Feedback visual de "Votado"
            };
            container.appendChild(btn);
        }
    });
});

socket.on("playerEliminated", (name) => {
    if (name === myName) {
        isEliminated = true;
        els.eliminated.classList.remove('hidden');
        vibrate([500, 200, 500, 200, 1000]); // Vibración larga y triste
    }
});

socket.on("finalUpdate", (stats) => {
    if (stats.winner) {
        document.getElementById('winnerName').textContent = stats.winner;
        document.getElementById('winnerAmount').textContent = `$${stats.bankedTotal}`;
    } else {
        // Actualizar tablero
        document.getElementById('p1Name').textContent = stats.p1.name;
        document.getElementById('p2Name').textContent = stats.p2.name;
        renderOvals('p1Ovals', stats.p1.history);
        renderOvals('p2Ovals', stats.p2.history);
    }
});

function renderOvals(id, history) {
    const container = document.getElementById(id);
    container.innerHTML = '';
    // Siempre mostrar 5 espacios mínimo
    const count = Math.max(5, history.length + 1);
    for(let i=0; i<count; i++) {
        const div = document.createElement('div');
        div.className = 'oval';
        if (i < history.length) {
            div.classList.add(history[i] ? 'correct' : 'wrong');
            div.textContent = history[i] ? '✔' : '✖';
        }
        container.appendChild(div);
    }
}