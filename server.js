const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// IMPORTAR PREGUNTAS DESDE ARCHIVO EXTERNO
const questionsList = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

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
    bank: { total: 0, roundTotal: 0, chainIndex: -1, currentValue: 0 },
    
    // Manejo de preguntas aleatorias
    currentQuestion: null,
    lastCategory: null,
    
    stats: {}, 
    votes: {}, 
    detailedVotes: [],
    final: { active: false, p1: null, p2: null, winner: null, suddenDeath: false }
};

let timerInterval = null;
let playerSockets = {}; 

// --- FUNCIÓN PARA OBTENER PREGUNTA ALEATORIA (SIN REPETIR CATEGORÍA) ---
function getNextRandomQuestion() {
    // 1. Filtrar preguntas que NO sean de la misma categoría anterior
    let available = questionsList.filter(q => q.category !== gameState.lastCategory);
    
    // Si no hay preguntas disponibles (caso raro o solo queda 1 categoría), usar todas
    if (available.length === 0) {
        available = questionsList;
    }
    
    // 2. Elegir una al azar
    const randomIndex = Math.floor(Math.random() * available.length);
    const selected = available[randomIndex];
    
    // 3. Actualizar última categoría
    gameState.lastCategory = selected.category;
    gameState.currentQuestion = selected;
    
    return selected;
}

const getCurrentPlayer = () => {
    if (gameState.phase === 'penalty' || gameState.phase === 'final_intro') {
        return gameState.final.turn === 0 ? gameState.final.p1.name : gameState.final.p2.name;
    }
    return gameState.turnOrder[gameState.turnIndex % gameState.turnOrder.length] || "Nadie";
};

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
        bankedTotal: gameState.bank.total,
        bankedRound: gameState.bank.roundTotal 
    });
    io.emit("turnUpdate", getCurrentPlayer());
    updateRanking();
    
    if (gameState.final.active) {
        io.emit("finalState", gameState.final);
    }
    
    if((gameState.phase === "questions" || gameState.phase === "penalty") && gameState.currentQuestion) {
        io.emit("questionUpdate", gameState.currentQuestion);
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

// --- CORRECCIÓN LÓGICA DE PENALES ---
function checkPenaltyWinner() {
    const p1 = gameState.final.p1;
    const p2 = gameState.final.p2;
    
    const score1 = p1.history.filter(x => x === true).length;
    const score2 = p2.history.filter(x => x === true).length;
    
    const shots1 = p1.history.length;
    const shots2 = p2.history.length;
    
    // 1. FASE REGULAR (Mejor de 5)
    // Solo declaramos ganador si matemáticamente el otro NO puede alcanzarlo
    // PERO: Si van 5 tiros exactos cada uno, se define por score.
    
    if (shots1 <= 5 || shots2 <= 5) {
        const remaining1 = 5 - shots1;
        const remaining2 = 5 - shots2;
        
        // P1 ya ganó (P2 no lo alcanza ni acertando todo lo que le falta)
        if (score1 > score2 + remaining2) gameState.final.winner = p1.name;
        // P2 ya ganó
        else if (score2 > score1 + remaining1) gameState.final.winner = p2.name;
        
        // Empate al final de los 5 tiros -> Activar Muerte Súbita
        else if (shots1 === 5 && shots2 === 5 && score1 === score2) {
            gameState.final.suddenDeath = true;
        }
    }
    // 2. MUERTE SÚBITA (Shots > 5)
    else {
        gameState.final.suddenDeath = true;
        
        // CORRECCIÓN CRÍTICA:
        // Solo verificamos ganador cuando AMBOS hayan tirado la misma cantidad (pares de tiros)
        if (shots1 === shots2) {
            if (score1 > score2) gameState.final.winner = p1.name;
            else if (score2 > score1) gameState.final.winner = p2.name;
        }
    }

    if (gameState.final.winner) {
        io.emit("finalWinner", { 
            name: gameState.final.winner, 
            amount: gameState.bank.total 
        });
    }
}

io.on("connection", (socket) => {
    socket.emit("phaseChanged", gameState.phase);
    socket.emit("playersUpdated", gameState.players);
    if(gameState.phase === "questions" && gameState.currentQuestion) socket.emit("questionUpdate", gameState.currentQuestion);
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
            bank: { total: 0, roundTotal: 0, chainIndex: -1, currentValue: 0 },
            currentQuestion: null, lastCategory: null,
            questionIndex: 0, stats: {}, votes: {}, detailedVotes: [],
            final: { active: false, p1: null, p2: null, winner: null, suddenDeath: false }
        };
        playerSockets = {};
        io.emit("gameReset");
        io.emit("playersUpdated", []); 
        broadcastState();
    });

    socket.on("setPhase", (phase) => {
        if (phase === "penalty") {
            gameState.final.active = true;
            if(gameState.players.length >= 2) {
                gameState.final.p1 = { name: gameState.players[0], history: [] };
                gameState.final.p2 = { name: gameState.players[1], history: [] };
            }
            gameState.final.turn = 0; 
            gameState.final.winner = null;
            gameState.final.suddenDeath = false;
            
            gameState.phase = "final_intro";
            broadcastState();
            
            setTimeout(() => {
                gameState.phase = "penalty";
                // Generar primera pregunta para penales
                getNextRandomQuestion();
                broadcastState();
            }, 4000);
            return;
        }

        gameState.phase = phase;
        
        if (phase === "questions") {
            gameState.bank.chainIndex = -1;
            gameState.bank.currentValue = 0;
            gameState.bank.roundTotal = 0;
            
            // Generar primera pregunta aleatoria
            getNextRandomQuestion();
            io.emit("questionUpdate", gameState.currentQuestion);
            
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
        if (gameState.phase === "penalty") {
            if (gameState.final.winner) return;
            const isP1 = gameState.final.turn === 0;
            if (isP1) gameState.final.p1.history.push(true);
            else gameState.final.p2.history.push(true);
            
            // Checar ganador ANTES de cambiar turno
            checkPenaltyWinner();
            
            // Si ya hubo ganador tras el chequeo, no generar nueva pregunta ni cambiar turno
            if (gameState.final.winner) {
                broadcastState();
                return;
            }

            gameState.final.turn = gameState.final.turn === 0 ? 1 : 0;
            getNextRandomQuestion();
            broadcastState();
            return;
        }

        const player = getCurrentPlayer();
        if (gameState.stats[player]) gameState.stats[player].correct++;
        
        if (isNaN(gameState.bank.chainIndex)) gameState.bank.chainIndex = -1;
        const maxIndex = CHAIN_VALUES.length - 1; 

        if (gameState.bank.chainIndex === maxIndex) {
            const maxVal = CHAIN_VALUES[maxIndex]; 
            gameState.bank.total += maxVal;
            gameState.bank.roundTotal += maxVal;
            if (gameState.stats[player]) {
                gameState.stats[player].bankAmount += maxVal;
                gameState.stats[player].bankCount++;
            }
            gameState.bank.chainIndex = -1;
            gameState.bank.currentValue = 0;
            io.emit("bankSuccess");
        } else {
            gameState.bank.chainIndex++;
            gameState.bank.currentValue = CHAIN_VALUES[gameState.bank.chainIndex];
        }
        
        getNextRandomQuestion();
        advanceTurn();
        broadcastState();
    });

    socket.on("wrongAnswer", () => {
        if (gameState.phase === "penalty") {
            if (gameState.final.winner) return;
            const isP1 = gameState.final.turn === 0;
            if (isP1) gameState.final.p1.history.push(false);
            else gameState.final.p2.history.push(false);
            
            checkPenaltyWinner();
            
            if (gameState.final.winner) {
                broadcastState();
                return;
            }
            
            gameState.final.turn = gameState.final.turn === 0 ? 1 : 0;
            getNextRandomQuestion();
            broadcastState();
            return;
        }

        const player = getCurrentPlayer();
        if (gameState.stats[player]) gameState.stats[player].wrong++;
        
        gameState.bank.chainIndex = -1;
        gameState.bank.currentValue = 0;
        
        getNextRandomQuestion();
        advanceTurn();
        broadcastState();
    });

    socket.on("bank", () => {
        if (gameState.bank.currentValue > 0) {
            gameState.bank.total += gameState.bank.currentValue;
            gameState.bank.roundTotal += gameState.bank.currentValue;
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
        
        gameState.round++;
        gameState.phase = "waiting"; 
        broadcastState();
    });
});

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
