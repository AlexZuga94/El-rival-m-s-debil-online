const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
// Asegúrate de tener tu archivo questions.js en la misma carpeta
const questionsList = require("./questions"); 

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Permite conexiones desde cualquier lugar
});

app.use(express.static(__dirname));

// ===== VARIABLES DE ESTADO =====
const ROUND_TIME_BASE = 20; // Tiempo base por ronda
const CHAIN_VALUES = [1, 2, 5, 10, 20, 50, 100]; // Valores de la cadena

let gameState = {
    players: [],
    turnOrder: [],
    turnIndex: 0,
    round: 1,
    phase: "waiting", // waiting, questions, times_up, intermission, voting, elimination, final_intro, final, final_result, sudden_death_intro
    timer: ROUND_TIME_BASE,
    bank: {
        total: 0,
        chainIndex: -1,
        currentValue: 0
    },
    questionIndex: 0,
    stats: {}, // { name: { correct, wrong, bankAmount, bankCount } }
    votes: {},
    detailedVotes: [],
    final: {
        active: false,
        p1: { name: "", score: 0, history: [] },
        p2: { name: "", score: 0, history: [] },
        winner: null,
        suddenDeath: false
    }
};

let timerInterval = null;
let playerSockets = {}; // Map socket.id -> playerName

// ===== HELPERS =====
const getCurrentPlayer = () => gameState.turnOrder[gameState.turnIndex % gameState.turnOrder.length] || null;

const advanceTurn = () => {
    if (gameState.turnOrder.length === 0) return;
    gameState.turnIndex = (gameState.turnIndex + 1) % gameState.turnOrder.length;
    io.emit("turnUpdate", getCurrentPlayer());
};

const nextQuestion = () => {
    if (gameState.questionIndex >= questionsList.length) gameState.questionIndex = 0;
    io.emit("questionUpdate", questionsList[gameState.questionIndex]);
    gameState.questionIndex++; // Prepara la siguiente
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
    // Solo enviar stats completas al host, ranking simplificado a todos si es necesario
    if(gameState.final.active) io.emit("finalUpdate", gameState.final);
};

const updateRanking = () => {
    const ranking = gameState.players.map(name => ({
        name,
        correct: gameState.stats[name]?.correct || 0,
        wrong: gameState.stats[name]?.wrong || 0,
        bankAmount: gameState.stats[name]?.bankAmount || 0
    }));
    io.emit("rankingUpdate", ranking);
};

// ===== GAME LOGIC =====
io.on("connection", (socket) => {
    // Estado inicial al conectar
    broadcastState();
    io.to(socket.id).emit("turnUpdate", getCurrentPlayer());
    
    // --- REGISTRO ---
    socket.on("registerPlayer", (name) => {
        const cleanName = name.trim().toUpperCase(); // Nombres en mayúscula siempre
        if (!gameState.players.includes(cleanName)) {
            gameState.players.push(cleanName);
            gameState.turnOrder.push(cleanName);
            playerSockets[socket.id] = cleanName;
            gameState.stats[cleanName] = { correct: 0, wrong: 0, bankAmount: 0, bankCount: 0 };
            
            io.emit("playersUpdated", gameState.players);
            updateRanking();
        } else {
            // Reconexión (Si el nombre ya existe, actualizamos el socket)
            playerSockets[socket.id] = cleanName;
            // Opcional: Avisar al usuario que se reconectó
        }
    });

    // --- RESET ---
    socket.on("resetGame", () => {
        clearInterval(timerInterval);
        gameState = {
            players: [], turnOrder: [], turnIndex: 0, round: 1, phase: "waiting",
            timer: ROUND_TIME_BASE,
            bank: { total: 0, chainIndex: -1, currentValue: 0 },
            questionIndex: 0, stats: {}, votes: {}, detailedVotes: [],
            final: { active: false, p1: { name:"", score:0, history:[] }, p2: { name:"", score:0, history:[] }, winner: null, suddenDeath: false }
        };
        playerSockets = {};
        io.emit("gameReset");
    });

    // --- CONTROL DE FASES ---
    socket.on("setPhase", (phase) => {
        gameState.phase = phase;
        broadcastState();

        if (phase === "questions") {
            nextQuestion();
            io.emit("turnUpdate", getCurrentPlayer());
            startTimer();
        } else {
            clearInterval(timerInterval);
        }
    });

    // --- JUEGO: RESPUESTAS ---
    socket.on("correctAnswer", () => {
        if (gameState.final.active) {
            handleFinalAnswer(true);
        } else {
            const player = getCurrentPlayer();
            if (player) gameState.stats[player].correct++;
            
            if (gameState.bank.chainIndex < CHAIN_VALUES.length - 1) {
                gameState.bank.chainIndex++;
                gameState.bank.currentValue = CHAIN_VALUES[gameState.bank.chainIndex];
            }
            
            nextQuestion();
            advanceTurn();
            broadcastState();
            updateRanking();
        }
    });

    socket.on("wrongAnswer", () => {
        if (gameState.final.active) {
            handleFinalAnswer(false);
        } else {
            const player = getCurrentPlayer();
            if (player) gameState.stats[player].wrong++;
            
            // Romper cadena
            gameState.bank.chainIndex = -1;
            gameState.bank.currentValue = 0;
            
            nextQuestion();
            advanceTurn();
            broadcastState();
            updateRanking();
        }
    });

    // --- JUEGO: BANCA ---
    socket.on("bank", () => {
        if (gameState.final.active) return;
        
        const amount = gameState.bank.currentValue;
        if (amount > 0) {
            gameState.bank.total += amount;
            const player = getCurrentPlayer();
            if (player) {
                gameState.stats[player].bankAmount += amount;
                gameState.stats[player].bankCount++;
            }
            // Reset cadena
            gameState.bank.chainIndex = -1;
            gameState.bank.currentValue = 0;
            
            broadcastState();
            updateRanking();
            io.emit("bankSuccess"); // Sonido/Efecto visual
        }
    });

    // --- VOTACIÓN Y ELIMINACIÓN ---
    socket.on("vote", (target) => {
        const voter = playerSockets[socket.id];
        if (voter) {
            gameState.votes[target] = (gameState.votes[target] || 0) + 1;
            if (!gameState.detailedVotes.find(v => v.voter === voter)) {
                gameState.detailedVotes.push({ voter, target });
            }
            io.emit("votesUpdated", { counts: gameState.votes, details: gameState.detailedVotes });
        }
    });

    socket.on("eliminatePlayer", (name) => {
        // Eliminar lógica
        gameState.players = gameState.players.filter(p => p !== name);
        gameState.turnOrder = gameState.turnOrder.filter(p => p !== name);
        if (gameState.turnIndex >= gameState.turnOrder.length) gameState.turnIndex = 0;
        
        // Limpiar votos
        gameState.votes = {};
        gameState.detailedVotes = [];
        
        // Reset stats ronda actual (opcional, según reglas)
        // gameState.players.forEach(p => { if(gameState.stats[p]) { gameState.stats[p].bankCount = 0; } });

        io.emit("playerEliminated", name);
        io.emit("playersUpdated", gameState.players);
        
        // DETECTAR FINAL
        if (gameState.players.length === 2) {
            setupFinal();
        } else {
            // Siguiente ronda normal
            gameState.round++;
            gameState.phase = "elimination"; // Mostrar roja
            broadcastState();
            
            setTimeout(() => {
                gameState.phase = "waiting";
                // Reducir tiempo en siguientes rondas?
                // gameState.timer = Math.max(10, ROUND_TIME_BASE - (gameState.round * 5));
                broadcastState();
                io.emit("turnUpdate", null);
            }, 4000);
        }
    });
});

function startTimer() {
    clearInterval(timerInterval);
    // Ajuste de tiempo por ronda si deseas
    gameState.timer = Math.max(10, ROUND_TIME_BASE - ((gameState.round - 1) * 2)); 
    
    timerInterval = setInterval(() => {
        gameState.timer--;
        io.emit("timerUpdate", gameState.timer);
        
        if (gameState.timer <= 0) {
            clearInterval(timerInterval);
            gameState.phase = "times_up";
            broadcastState();
            setTimeout(() => {
                gameState.phase = "intermission";
                broadcastState();
            }, 3000);
        }
    }, 1000);
}

function setupFinal() {
    gameState.final.active = true;
    gameState.round = "FINAL";
    gameState.turnIndex = 0; // Reset turno al P1
    
    gameState.final.p1 = { name: gameState.players[0], score: 0, history: [] };
    gameState.final.p2 = { name: gameState.players[1], score: 0, history: [] };
    
    // Fase Eliminación -> Intro Final
    gameState.phase = "elimination";
    broadcastState();
    io.emit("turnUpdate", gameState.players[0]); // P1 empieza

    setTimeout(() => {
        gameState.phase = "final_intro";
        broadcastState();
    }, 4000);
}

function handleFinalAnswer(isCorrect) {
    if (gameState.final.winner) return;

    const currentPlayer = getCurrentPlayer();
    const isP1 = currentPlayer === gameState.final.p1.name;
    const pKey = isP1 ? 'p1' : 'p2';

    gameState.final[pKey].history.push(isCorrect);
    if (isCorrect) gameState.final[pKey].score++;

    // Verificar Ganador Matemático
    checkFinalWinner();

    if (!gameState.final.winner) {
        // Muerte Súbita Check
        const p1Hist = gameState.final.p1.history.length;
        const p2Hist = gameState.final.p2.history.length;
        
        if (p1Hist === 5 && p2Hist === 5 && gameState.final.p1.score === gameState.final.p2.score && !gameState.final.suddenDeath) {
            gameState.final.suddenDeath = true;
            gameState.phase = "sudden_death_intro";
            broadcastState();
            setTimeout(() => {
                gameState.phase = "final";
                broadcastState();
            }, 3000);
        } else {
           broadcastState(); 
        }

        // Avanzar
        nextQuestion();
        advanceTurn();
    } else {
        broadcastState(); // Enviar estado con ganador
    }
}

function checkFinalWinner() {
    const p1 = gameState.final.p1;
    const p2 = gameState.final.p2;
    
    // Gane en 5 rondas o menos (Matemático)
    const p1Rem = 5 - p1.history.length;
    const p2Rem = 5 - p2.history.length;
    
    if (p1.history.length <= 5 || p2.history.length <= 5) {
        const p1Max = p1.score + Math.max(0, p1Rem);
        const p2Max = p2.score + Math.max(0, p2Rem);
        
        if (p1.score > p2Max) declareWinner(p1.name);
        else if (p2.score > p1Max) declareWinner(p2.name);
    } 
    // Muerte súbita (rondas iguales > 5)
    else if (p1.history.length === p2.history.length) {
        if (p1.score > p2.score) declareWinner(p1.name);
        else if (p2.score > p1.score) declareWinner(p2.name);
    }
}

function declareWinner(name) {
    gameState.final.winner = name;
    gameState.phase = "final_result";
    broadcastState();
}

// PUERTO DINÁMICO PARA LA NUBE
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor Rival Más Débil listo en puerto ${PORT}`);
});