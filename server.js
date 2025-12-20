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
    { question: "¿Metal precioso amarillo?", answer: "Oro" }
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
    final: { active: false, p1: null, p2: null, winner: null, suddenDeath: false }
};

let timerInterval = null;
let playerSockets = {}; 

const getCurrentPlayer = () => gameState.turnOrder[gameState.turnIndex % gameState.turnOrder.length] || "Nadie";

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
    io.emit("bankState", { 
        chain: CHAIN_VALUES, 
        chainIndex: gameState.bank.chainIndex, 
        currentChainValue: gameState.bank.currentValue, 
        bankedTotal: gameState.bank.total 
    });
    io.emit("turnUpdate", getCurrentPlayer());
    updateRanking();
    
    if(gameState.phase === "questions") {
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

const checkVotingResults = () => {
    const activeVoters = gameState.players.length;
    const votesCast = gameState.detailedVotes.length;

    if (votesCast >= activeVoters) {
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
        gameState.phase = phase;
        
        if (phase === "questions") {
            io.emit("questionUpdate", questionsList[gameState.questionIndex]);
            startTimer();
        } else if (phase === "voting") {
            clearInterval(timerInterval);
            
            // PUNTO 2: Reiniciar escalera al entrar a votación
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
        if (gameState.final.active) { handleFinalAnswer(true); return; }
        
        const player = getCurrentPlayer();
        if (gameState.stats[player]) gameState.stats[player].correct++;
        
        // Auto-Banca al máximo
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
        if (gameState.final.active) { handleFinalAnswer(false); return; }
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
        
        if (gameState.players.length === 2) {
             setupFinal();
        } else {
             gameState.round++;
             gameState.phase = "waiting"; 
             broadcastState();
        }
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

function setupFinal() {
    gameState.final.active = true;
    gameState.phase = "final_intro";
    gameState.final.p1 = { name: gameState.players[0], score: 0, history: [] };
    gameState.final.p2 = { name: gameState.players[1], score: 0, history: [] };
    broadcastState();
    io.emit("finalUpdate", gameState.final);
}

function handleFinalAnswer(isCorrect) {
    const p = getCurrentPlayer();
    const isP1 = p === gameState.final.p1.name;
    const target = isP1 ? gameState.final.p1 : gameState.final.p2;
    target.history.push(isCorrect);
    if(isCorrect) target.score++;
    io.emit("finalUpdate", gameState.final);
    advanceTurn();
    broadcastState();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
