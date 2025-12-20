const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// --- PREGUNTAS ---
const questionsList = [
    { question: "¿Planeta más cercano al Sol?", answer: "Mercurio" },
    { question: "¿Lados de un hexágono?", answer: "Seis" },
    { question: "¿Dónde está la Torre Eiffel?", answer: "Francia" },
    { question: "¿Símbolo químico H?", answer: "Hidrógeno" },
    { question: "¿Autor del Quijote?", answer: "Cervantes" },
    { question: "¿Capital de Italia?", answer: "Roma" },
    { question: "¿Color de la esperanza?", answer: "Verde" },
    { question: "¿Moneda de Japón?", answer: "Yen" },
    { question: "¿Patas de una araña?", answer: "Ocho" },
    { question: "¿Metal precioso amarillo?", answer: "Oro" },
    { question: "¿Cuál es el océano más grande?", answer: "Pacífico" },
    { question: "¿Cuántos años tiene un siglo?", answer: "100" }
];

// CONFIGURACIÓN
const ROUND_TIME_BASE = 20; 
const CHAIN_VALUES = [1, 2, 5, 10, 20, 50, 100]; 

let gameState = {
    players: [],
    turnOrder: [],
    turnIndex: 0,
    round: 1,
    phase: "waiting", 
    timer: ROUND_TIME_BASE,
    bank: { total: 0, chainIndex: -1, currentValue: 0 },
    questionIndex: 0,
    stats: {}, 
    votes: {}, 
    detailedVotes: [],
    // NUEVO: OBJETO PARA LA FINAL
    final: { 
        active: false, 
        p1: null, // { name: "JUAN", history: [true, false, true...] }
        p2: null, 
        turn: 0, // 0 para p1, 1 para p2
        winner: null 
    }
};

let timerInterval = null;
let playerSockets = {}; 

const getCurrentPlayer = () => {
    if (gameState.phase === 'penalty') {
        return gameState.final.turn === 0 ? gameState.final.p1.name : gameState.final.p2.name;
    }
    return gameState.turnOrder[gameState.turnIndex % gameState.turnOrder.length] || "Nadie";
};

// ... (getStrongestPlayerName se mantiene igual) ...
const getStrongestPlayerName = () => {
    if (gameState.players.length === 0) return null;
    const sorted = [...gameState.players].sort((a, b) => {
        const statsA = gameState.stats[a] || { correct: 0 };
        const statsB = gameState.stats[b] || { correct: 0 };
        return statsB.correct - statsA.correct;
    });
    return sorted[0];
};

const broadcastState = () => {
    io.emit("phaseChanged", gameState.phase);
    io.emit("roundUpdate", gameState.round);
    
    if (typeof gameState.bank.chainIndex !== 'number' || isNaN(gameState.bank.chainIndex)) {
        gameState.bank.chainIndex = -1;
        gameState.bank.currentValue = 0;
    }

    io.emit("bankState", { 
        chain: CHAIN_VALUES, 
        chainIndex: gameState.bank.chainIndex, 
        currentChainValue: gameState.bank.currentValue, 
        bankedTotal: gameState.bank.total 
    });
    io.emit("turnUpdate", getCurrentPlayer());
    updateRanking();
    
    // Enviar estado de la final si es necesario
    if (gameState.final.active) {
        io.emit("finalState", gameState.final);
    }
    
    if(gameState.phase === "questions" || gameState.phase === "penalty") {
        io.emit("questionUpdate", questionsList[gameState.questionIndex]);
    }
};

const updateRanking = () => {
    const ranking = gameState.players.map(name => ({
        name,
        correct: gameState.stats[name]?.correct || 0,
        wrong: gameState.stats[name]?.wrong || 0,
        bankAmount: gameState.stats[name]?.bankAmount || 0,
        bankCount: gameState.stats[name]?.bankCount || 0
    }));
    io.emit("rankingUpdate", ranking);
};

// ... (checkVotingResults se mantiene igual) ...
const checkVotingResults = () => {
    const activeVoters = gameState.players.length;
    const votesCast = gameState.detailedVotes.length;

    if (activeVoters > 0 && votesCast >= activeVoters) {
        let counts = {};
        gameState.detailedVotes.forEach(v => { counts[v.target] = (counts[v.target] || 0) + 1; });

        let maxVotes = 0;
        let candidates = [];
        for (const [player, count] of Object.entries(counts)) {
            if (count > maxVotes) { maxVotes = count; candidates = [player]; } 
            else if (count === maxVotes) { candidates.push(player); }
        }

        if (candidates.length === 1) {
            io.emit("votingResult", { type: "clear", target: candidates[0], count: maxVotes });
        } else {
            io.emit("votingResult", { type: "tie", targets: candidates, count: maxVotes, decisionMaker: getStrongestPlayerName() });
        }
    }
};

io.on("connection", (socket) => {
    socket.emit("phaseChanged", gameState.phase);
    socket.emit("playersUpdated", gameState.players);
    if(gameState.phase === "questions") socket.emit("questionUpdate", questionsList[gameState.questionIndex]);
    broadcastState();

    socket.on("registerPlayer", (name) => {
        const cleanName = name.trim().toUpperCase();
        if (!gameState.players.includes(cleanName)) {
            gameState.players.push(cleanName);
            gameState.turnOrder.push(cleanName);
            playerSockets[socket.id] = cleanName;
            gameState.stats[cleanName] = { correct: 0, wrong: 0, bankAmount: 0, bankCount: 0 };
            io.emit("playersUpdated", gameState.players);
            updateRanking();
        } else {
             playerSockets[socket.id] = cleanName; 
             io.emit("playersUpdated", gameState.players);
        }
    });

    socket.on("resetGame", () => {
        clearInterval(timerInterval);
        gameState = {
            players: [], turnOrder: [], turnIndex: 0, round: 1, phase: "waiting",
            timer: ROUND_TIME_BASE,
            bank: { total: 0, chainIndex: -1, currentValue: 0 },
            questionIndex: 0, stats: {}, votes: {}, detailedVotes: [],
            final: { active: false, p1: null, p2: null, winner: null, suddenDeath: false }
        };
        playerSockets = {};
        io.emit("gameReset");
        io.emit("playersUpdated", []); 
        broadcastState();
    });

    socket.on("setPhase", (phase) => {
        // LÓGICA ESPECIAL PARA INICIAR PENALES
        if (phase === "penalty") {
            gameState.final.active = true;
            // Configurar finalistas
            gameState.final.p1 = { name: gameState.players[0], history: [] };
            gameState.final.p2 = { name: gameState.players[1], history: [] };
            gameState.final.turn = 0; // Empieza P1
            gameState.phase = "penalty";
            broadcastState();
            return;
        }

        gameState.phase = phase;
        
        if (phase === "questions") {
            gameState.bank.chainIndex = -1;
            gameState.bank.currentValue = 0;
            io.emit("questionUpdate", questionsList[gameState.questionIndex]);
            startTimer();
        } 
        else if (phase === "voting") {
            clearInterval(timerInterval);
            gameState.bank.chainIndex = -1;
            gameState.bank.currentValue = 0;
            gameState.votes = {};
            gameState.detailedVotes = [];
            io.emit("votesUpdated", { summary: {}, details: [] });
            io.emit("votingResult", null);
        } else {
            clearInterval(timerInterval);
        }
        broadcastState();
    });

    socket.on("correctAnswer", () => {
        // --- LÓGICA DE PENALES ---
        if (gameState.phase === "penalty") {
            const isP1 = gameState.final.turn === 0;
            if (isP1) gameState.final.p1.history.push(true); // true = acierto
            else gameState.final.p2.history.push(true);
            
            // Cambio de turno
            gameState.final.turn = gameState.final.turn === 0 ? 1 : 0;
            
            gameState.questionIndex = (gameState.questionIndex + 1) % questionsList.length;
            broadcastState();
            checkWinner(); // Verificar si ya ganó alguien
            return;
        }

        // Lógica normal...
        const player = getCurrentPlayer();
        if (gameState.stats[player]) gameState.stats[player].correct++;
        
        if (isNaN(gameState.bank.chainIndex)) gameState.bank.chainIndex = -1;
        const maxIndex = CHAIN_VALUES.length - 1;
        
        if (gameState.bank.chainIndex === maxIndex - 1) {
            const maxVal = CHAIN_VALUES[maxIndex];
            gameState.bank.total += maxVal;
            if (gameState.stats[player]) {
                gameState.stats[player].bankAmount += maxVal;
                gameState.stats[player].bankCount++;
            }
            gameState.bank.chainIndex = -1;
            gameState.bank.currentValue = 0;
            io.emit("bankSuccess");
        } else {
            if (gameState.bank.chainIndex < maxIndex) {
                gameState.bank.chainIndex++;
                gameState.bank.currentValue = CHAIN_VALUES[gameState.bank.chainIndex];
            }
        }
        
        gameState.questionIndex = (gameState.questionIndex + 1) % questionsList.length;
        advanceTurn();
        broadcastState();
    });

    socket.on("wrongAnswer", () => {
        // --- LÓGICA DE PENALES ---
        if (gameState.phase === "penalty") {
            const isP1 = gameState.final.turn === 0;
            if (isP1) gameState.final.p1.history.push(false); // false = error
            else gameState.final.p2.history.push(false);
            
            gameState.final.turn = gameState.final.turn === 0 ? 1 : 0;
            
            gameState.questionIndex = (gameState.questionIndex + 1) % questionsList.length;
            broadcastState();
            checkWinner();
            return;
        }

        // Lógica normal...
        const player = getCurrentPlayer();
        if (gameState.stats[player]) gameState.stats[player].wrong++;
        gameState.bank.chainIndex = -1;
        gameState.bank.currentValue = 0;
        gameState.questionIndex = (gameState.questionIndex + 1) % questionsList.length;
        advanceTurn();
        broadcastState();
    });

    socket.on("bank", () => {
        if (gameState.bank.currentValue > 0) {
            gameState.bank.total += gameState.bank.currentValue;
            const player = getCurrentPlayer();
            if (gameState.stats[player]) {
                gameState.stats[player].bankAmount += gameState.bank.currentValue;
                gameState.stats[player].bankCount++;
            }
            gameState.bank.chainIndex = -1;
            gameState.bank.currentValue = 0;
            broadcastState();
            io.emit("bankSuccess");
        }
    });

    socket.on("vote", (target) => {
        const voterName = playerSockets[socket.id];
        if (voterName && gameState.players.includes(voterName)) {
            const alreadyVoted = gameState.detailedVotes.find(v => v.voter === voterName);
            if (alreadyVoted) return;
            gameState.votes[target] = (gameState.votes[target] || 0) + 1;
            gameState.detailedVotes.push({ voter: voterName, target: target });
            io.emit("votesUpdated", { summary: gameState.votes, details: gameState.detailedVotes });
            checkVotingResults();
        }
    });

    socket.on("eliminatePlayer", (name) => {
        gameState.players = gameState.players.filter(p => p !== name);
        gameState.turnOrder = gameState.turnOrder.filter(p => p !== name);
        if (gameState.turnIndex >= gameState.turnOrder.length) gameState.turnIndex = 0;
        
        gameState.votes = {};
        gameState.detailedVotes = [];
        io.emit("playerEliminated", name);
        io.emit("playersUpdated", gameState.players);
        
        // CORRECCIÓN: Si quedan 2, jugamos UNA RONDA MÁS antes de los penales
        // Pero marcamos una variable interna si quisieras, o simplemente el Host lo sabe.
        // Aquí seguimos la lógica normal: aumentamos ronda y a esperar.
        // La diferencia es visual en el Host (ver Host.html).
        
        gameState.round++;
        gameState.phase = "waiting"; 
        broadcastState();
    });
});

function checkWinner() {
    // Lógica simple de "Mejor de 5" o Muerte Súbita
    // Solo emitimos si hay ganador, el cliente muestra el mensaje
    // Para simplificar, el Host decidirá cuándo parar si es muy complejo,
    // pero aquí calculamos score básico.
    
    // Puedes expandir esta función para automatizar el "Ganador Matemático"
    // De momento, solo guardamos el estado y que el Host lo vea.
}

function advanceTurn() {
    if (gameState.turnOrder.length === 0) return;
    gameState.turnIndex = (gameState.turnIndex + 1) % gameState.turnOrder.length;
}

function startTimer() {
    clearInterval(timerInterval);
    gameState.timer = Math.max(10, ROUND_TIME_BASE - ((gameState.round - 1) * 2));
    io.emit("timerUpdate", gameState.timer);
    timerInterval = setInterval(() => {
        gameState.timer--;
        io.emit("timerUpdate", gameState.timer);
        if (gameState.timer <= 0) {
            clearInterval(timerInterval);
            gameState.phase = "times_up"; 
            broadcastState();
        }
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
