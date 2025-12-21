const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// IMPORTAR PREGUNTAS DESDE EL ARCHIVO EXTERNO
const questionsList = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// --- CONFIGURACIÓN DE TIEMPOS ---
const INITIAL_ROUND_TIME = 180; // 3 Minutos
const TIME_REDUCTION_PER_ROUND = 10; 
const FINAL_DUEL_TIME = 90;    // 1:30 para final
const CHAIN_VALUES = [1, 2, 5, 10, 20, 50, 100]; 

const getCurrentPlayer = () => {
    if (gameState.phase === 'penalty' || gameState.phase === 'final_intro') {
        return gameState.final.turn === 0 ? gameState.final.p1.name : gameState.final.p2.name;
    }
    // Seguridad: si no hay jugadores en la lista de turnos
    if (!gameState.turnOrder || gameState.turnOrder.length === 0) return "Nadie";
    
    return gameState.turnOrder[gameState.turnIndex % gameState.turnOrder.length] || "Nadie";
};

let gameState = {
    players: [],
    turnOrder: [],
    turnIndex: 0,
    round: 1,
    phase: "waiting", 
    timer: INITIAL_ROUND_TIME, 
    bank: { total: 0, roundTotal: 0, chainIndex: -1, currentValue: 0 },
    
    // CORRECCIÓN: Memoria para no repetir
    currentQuestion: null,
    lastCategory: null,
    usedQuestions: [], 
    
    stats: {}, 
    votes: {}, 
    detailedVotes: [],
    final: { active: false, p1: null, p2: null, winner: null, suddenDeath: false, turn: 0 }
};

let timerInterval = null;
let playerSockets = {}; 

// --- LÓGICA SIN REPETIR PREGUNTAS ---
function getNextRandomQuestion() {
    let available = questionsList.filter(q => !gameState.usedQuestions.includes(q.question));
    
    if (available.length === 0) {
        gameState.usedQuestions = [];
        available = questionsList;
    }
    
    let candidates = available.filter(q => q.category !== gameState.lastCategory);
    if (candidates.length === 0) candidates = available;
    
    const randomIndex = Math.floor(Math.random() * candidates.length);
    const selected = candidates[randomIndex];
    
    gameState.lastCategory = selected.category;
    gameState.currentQuestion = selected;
    gameState.usedQuestions.push(selected.question); 
    
    return selected;
}


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
    const activePlayersNames = gameState.players; 
    const votesCast = gameState.detailedVotes.length;

    if (activePlayersNames.length > 0 && votesCast >= activePlayersNames.length) {
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

function checkPenaltyWinner() {
    const p1 = gameState.final.p1;
    const p2 = gameState.final.p2;
    const score1 = p1.history.filter(x => x === true).length;
    const score2 = p2.history.filter(x => x === true).length;
    const shots1 = p1.history.length;
    const shots2 = p2.history.length;
    
    if (shots1 <= 5 && shots2 <= 5) {
        const remaining1 = 5 - shots1;
        const remaining2 = 5 - shots2;
        
        if (score1 > score2 + remaining2) gameState.final.winner = p1.name;
        else if (score2 > score1 + remaining1) gameState.final.winner = p2.name;
        else if (shots1 === 5 && shots2 === 5 && score1 === score2) {
            gameState.final.suddenDeath = true;
        }
    } 
    else {
        gameState.final.suddenDeath = true;
        if (shots1 === shots2) {
            if (score1 > score2) gameState.final.winner = p1.name;
            else if (score2 > score1) gameState.final.winner = p2.name;
        }
    }

    if (gameState.final.winner) {
        io.emit("finalWinner", { name: gameState.final.winner, amount: gameState.bank.total });
    }
}

function startTimer() {
    clearInterval(timerInterval);

    if (gameState.players.length === 2) {
        gameState.timer = FINAL_DUEL_TIME;
    } else {
        gameState.timer = INITIAL_ROUND_TIME - ((gameState.round - 1) * TIME_REDUCTION_PER_ROUND);
    }

    if (gameState.timer < 30) gameState.timer = 30; 

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

io.on("connection", (socket) => {

    // --- MANEJO DE DESCONEXIONES (SALIDA PERMANENTE) ---
    socket.on("disconnect", () => {
        const name = playerSockets[socket.id];
        if (name) {
            console.log(`⚠️ Jugador fuera del juego por desconexión: ${name}`);
            
            // Verificamos si era su turno antes de borrarlo
            const wasHisTurn = (getCurrentPlayer() === name);

            // 1. Lo borramos de todas las listas de juego
            gameState.players = gameState.players.filter(p => p !== name);
            gameState.turnOrder = gameState.turnOrder.filter(p => p !== name);
            
            // 2. Si era su turno en ronda de preguntas, saltamos al siguiente
            if (wasHisTurn && gameState.phase === "questions") {
                if (gameState.turnOrder.length > 0) {
                    // Re-ajustamos el índice para que no se salte a nadie por el hueco dejado
                    if (gameState.turnIndex >= gameState.turnOrder.length) {
                        gameState.turnIndex = 0;
                    }
                    getNextRandomQuestion();
                } else {
                    // Si ya no queda nadie vivo
                    clearInterval(timerInterval);
                    gameState.phase = "waiting";
                }
            }

            // 3. Limpiamos sus datos de conexión
            delete playerSockets[socket.id];

            // 4. Avisamos a todos (Host y Jugadores restantes)
            io.emit("playerEliminated", name); // Esto activará el sonido en el Host
            io.emit("playersUpdated", gameState.players);
            updateRanking();
            broadcastState();
        }
    });
    socket.emit("phaseChanged", gameState.phase);
    socket.emit("playersUpdated", gameState.players);
    socket.emit("timerUpdate", gameState.timer);
    broadcastState();

    socket.on("registerPlayer", (name) => {
        const cleanName = name.trim().toUpperCase();
        if (!gameState.players.includes(cleanName)) {
            gameState.players.push(cleanName);
            
            // --- NUEVO: ORDENAR ALFABÉTICAMENTE ---
            gameState.players.sort(); 
            gameState.turnOrder = [...gameState.players]; // Sincronizar el orden de turnos
            
            playerSockets[socket.id] = cleanName;
            gameState.stats[cleanName] = { correct: 0, wrong: 0, bankAmount: 0, bankCount: 0 };
            
            // Avisar a todos y actualizar ranking en el Host
            io.emit("playersUpdated", gameState.players);
            updateRanking();
            // Actualizar turno para que el Host vea quién empieza (el primero de la lista A-Z)
            io.emit("turnUpdate", getCurrentPlayer());
        }
    });

    socket.on("resetGame", () => {
        clearInterval(timerInterval);
        gameState = {
            players: [], turnOrder: [], turnIndex: 0, round: 1, phase: "waiting",
            timer: INITIAL_ROUND_TIME, 
            bank: { total: 0, roundTotal: 0, chainIndex: -1, currentValue: 0 },
            currentQuestion: null, lastCategory: null, usedQuestions: [], 
            stats: {}, votes: {}, detailedVotes: [],
            final: { active: false, p1: null, p2: null, winner: null, suddenDeath: false, turn: 0 }
        };
        io.emit("gameReset");
        broadcastState();
    });

    socket.on("setPhase", (phase) => {
        if (phase === "penalty") {
            gameState.final.active = true;
            gameState.final.p1 = { name: gameState.players[0], history: [] };
            gameState.final.p2 = { name: gameState.players[1], history: [] };
            gameState.final.turn = 0; 
            gameState.final.winner = null;
            gameState.final.suddenDeath = false;
            gameState.phase = "final_intro";
            broadcastState();
            setTimeout(() => {
                gameState.phase = "penalty";
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
            getNextRandomQuestion();
            startTimer();
        } else {
            clearInterval(timerInterval);
        }
        broadcastState();
    });

    socket.on("correctAnswer", () => {
        if (gameState.phase === "penalty") {
            if (gameState.final.winner) return;
            gameState.final.turn === 0 ? gameState.final.p1.history.push(true) : gameState.final.p2.history.push(true);
            checkPenaltyWinner();
            if (!gameState.final.winner) {
                gameState.final.turn = gameState.final.turn === 0 ? 1 : 0;
                getNextRandomQuestion();
            }
            broadcastState();
            return;
        }
        const player = getCurrentPlayer();
        if (gameState.stats[player]) gameState.stats[player].correct++;
        
        const maxIndex = CHAIN_VALUES.length - 1;
        if (gameState.bank.chainIndex === maxIndex) {
            gameState.bank.total += CHAIN_VALUES[maxIndex];
            gameState.bank.roundTotal += CHAIN_VALUES[maxIndex];
            gameState.bank.chainIndex = -1;
            gameState.bank.currentValue = 0;
        } else {
            gameState.bank.chainIndex++;
            gameState.bank.currentValue = CHAIN_VALUES[gameState.bank.chainIndex];
        }
        getNextRandomQuestion();
        gameState.turnIndex++;
        broadcastState();
    });

    socket.on("wrongAnswer", () => {
        if (gameState.phase === "penalty") {
            if (gameState.final.winner) return;
            gameState.final.turn === 0 ? gameState.final.p1.history.push(false) : gameState.final.p2.history.push(false);
            checkPenaltyWinner();
            if (!gameState.final.winner) {
                gameState.final.turn = gameState.final.turn === 0 ? 1 : 0;
                getNextRandomQuestion();
            }
            broadcastState();
            return;
        }
        const player = getCurrentPlayer();
        if (gameState.stats[player]) gameState.stats[player].wrong++;
        gameState.bank.chainIndex = -1;
        gameState.bank.currentValue = 0;
        getNextRandomQuestion();
        gameState.turnIndex++;
        broadcastState();
    });

    socket.on("bank", () => {
        if (gameState.bank.currentValue > 0) {
            gameState.bank.total += gameState.bank.currentValue;
            gameState.bank.roundTotal += gameState.bank.currentValue;
            gameState.bank.chainIndex = -1;
            gameState.bank.currentValue = 0;
            broadcastState();
        }
    });

    socket.on("vote", (target) => {
        const voterName = playerSockets[socket.id];
        if (voterName && gameState.players.includes(voterName)) {
            const alreadyVoted = gameState.detailedVotes.find(v => v.voter === voterName);
            if (!alreadyVoted) {
                gameState.votes[target] = (gameState.votes[target] || 0) + 1;
                gameState.detailedVotes.push({ voter: voterName, target: target });
                io.emit("votesUpdated", { summary: gameState.votes, details: gameState.detailedVotes });
                checkVotingResults();
            }
        }
    });

    socket.on("eliminatePlayer", (name) => {
        // 1. Quitar al eliminado de la lista de jugadores activos
        gameState.players = gameState.players.filter(p => p !== name);
        
        // 2. CALCULAR EL MÁS FUERTE DE LOS SOBREVIVIENTES (Para que empiece la ronda)
        const strongestSurvivor = getStrongestPlayerName();

        // 3. REORDENAR TURNOS
        // Primero ordenamos alfabéticamente para tener una base consistente
        gameState.players.sort(); 
        
        if (strongestSurvivor && gameState.players.includes(strongestSurvivor)) {
            // Buscamos dónde está el más fuerte
            const startIdx = gameState.players.indexOf(strongestSurvivor);
            
            // Hacemos la rotación: Ponemos al fuerte y los que le siguen primero...
            const part1 = gameState.players.slice(startIdx);
            // ...y los que estaban antes en el alfabeto, los ponemos al final
            const part2 = gameState.players.slice(0, startIdx);
            
            gameState.turnOrder = part1.concat(part2);
        } else {
            // Si es la ronda 1 o no hay datos, se queda alfabético
            gameState.turnOrder = [...gameState.players];
        }

        // Reiniciar el índice para que empiece el primero de la nueva lista (el más fuerte)
        gameState.turnIndex = 0;

        // 4. REINICIAR ESTADÍSTICAS DE RONDA
        // Esto es VITAL: Limpiamos aciertos/errores para que la próxima ronda 
        // tenga su propio "Rival Más Débil" fresco.
        gameState.players.forEach(p => {
             if(gameState.stats[p]) {
                 gameState.stats[p].correct = 0;
                 gameState.stats[p].wrong = 0;
                 // NOTA: No borramos el dinero (bankAmount) porque ese es acumulativo
             }
        });

        // Limpiar votos y notificar
        gameState.votes = {};
        gameState.detailedVotes = [];
        io.emit("playerEliminated", name);
        io.emit("playersUpdated", gameState.players);
        
        // Avanzar ronda y fase
        gameState.round++;
        gameState.phase = "waiting"; 
        broadcastState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));





