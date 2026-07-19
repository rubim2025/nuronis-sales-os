const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'nuronis-secret-key-2026';

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Banco de dados SQLite
const db = new sqlite3.Database('./nuronis.db');

// Criar tabelas
db.serialize(() => {
  // Usuários (gerentes)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf TEXT UNIQUE NOT NULL,
    senha TEXT NOT NULL,
    perfil TEXT DEFAULT 'gerente',
    ativo INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Relatórios
  db.run(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gerente_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    data_upload DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_clientes INTEGER DEFAULT 0,
    FOREIGN KEY (gerente_id) REFERENCES users(id)
  )`);

  // Clientes (simulações)
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    cpf TEXT,
    telefone TEXT,
    valor_simulado REAL,
    prazo INTEGER,
    data_simulacao TEXT,
    produto TEXT,
    canal TEXT,
    score INTEGER DEFAULT 0,
    arquetipo TEXT,
    prioridade TEXT DEFAULT 'media',
    status TEXT DEFAULT 'pendente',
    resultado TEXT,
    valor_venda REAL,
    motivo_perda TEXT,
    usou_roteiro TEXT,
    data_interacao DATETIME,
    tickets INTEGER DEFAULT 0,
    FOREIGN KEY (report_id) REFERENCES reports(id)
  )`);

  // Ranking/Sorteio
  db.run(`CREATE TABLE IF NOT EXISTS ranking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gerente_id INTEGER NOT NULL,
    semana TEXT NOT NULL,
    tickets INTEGER DEFAULT 0,
    vendas INTEGER DEFAULT 0,
    contactados INTEGER DEFAULT 0,
    posicao INTEGER DEFAULT 0,
    FOREIGN KEY (gerente_id) REFERENCES users(id)
  )`);

  // Inserir gerentes de teste (senha: 123456)
  const hash = bcrypt.hashSync('123456', 10);
  const gerentes = [
    ['João Silva', '11111111111'],
    ['Maria Lima', '22222222222'],
    ['Pedro Costa', '33333333333'],
    ['Ana Paula', '44444444444'],
    ['Carlos Eduardo', '55555555555']
  ];
  
  gerentes.forEach(([nome, cpf]) => {
    db.run(INSERT OR IGNORE INTO users (nome, cpf, senha) VALUES (?, ?, ?), 
      [nome, cpf, hash]);
  });

  console.log('✅ Banco de dados inicializado');
});

// Middleware de autenticação
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ========== ROTAS DE AUTENTICAÇÃO ==========

// Login
app.post('/api/login', (req, res) => {
  const { cpf, senha } = req.body;
  
  db.get('SELECT * FROM users WHERE cpf = ? AND ativo = 1', [cpf], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'CPF não encontrado' });
    
    const valid = bcrypt.compareSync(senha, user.senha);
    if (!valid) return res.status(401).json({ error: 'Senha incorreta' });
    
    const token = jwt.sign({ id: user.id, nome: user.nome }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, nome: user.nome, cpf: user.cpf } });
  });
});

// ========== ROTAS DE RELATÓRIOS ==========

// Criar relatório (colar dados do Excel)
app.post('/api/reports', authMiddleware, (req, res) => {
  const { nome, clientes } = req.body;
  const gerenteId = req.userId;
  
  db.run('INSERT INTO reports (gerente_id, nome, total_clientes) VALUES (?, ?, ?)',
    [gerenteId, nome, clientes.length], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      const reportId = this.lastID;
      let processed = 0;
      
      clientes.forEach(cliente => {
        // Calcular score e arquétipo
        const diasDesdeSimulacao = calcularDias(cliente.data_simulacao);
        const score = calcularScore(cliente.valor, cliente.prazo, diasDesdeSimulacao);
        const arquetipo = detectarArquetipo(cliente.valor, cliente.prazo);
        const prioridade = definirPrioridade(score, diasDesdeSimulacao);
        
        db.run(`INSERT INTO clients 
          (report_id, nome, cpf, telefone, valor_simulado, prazo, data_simulacao, 
           produto, canal, score, arquetipo, prioridade)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [reportId, cliente.nome, cliente.cpf, cliente.telefone, 
           cliente.valor, cliente.prazo, cliente.data_simulacao,
           cliente.produto, cliente.canal, score, arquetipo, prioridade],
          () => {
            processed++;
            if (processed === clientes.length) {
              res.json({ id: reportId, total: clientes.length });
            }
          }
        );
      });
    }
  );
});

// Listar relatórios do gerente
app.get('/api/reports', authMiddleware, (req, res) => {
  db.all(`SELECT r.*, 
    (SELECT COUNT(*) FROM clients WHERE report_id = r.id AND status = 'pendente') as pendentes
    FROM reports r WHERE r.gerente_id = ? ORDER BY r.data_upload DESC`,
    [req.userId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ========== ROTAS DE CLIENTES ==========

// Listar clientes de um relatório (priorizados)
app.get('/api/reports/:reportId/clients', authMiddleware, (req, res) => {
  const { reportId } = req.params;
  
  db.all(`SELECT * FROM clients 
    WHERE report_id = ? 
    ORDER BY 
      CASE prioridade 
        WHEN 'hoje' THEN 1 
        WHEN 'semana' THEN 2 
        WHEN 'mes' THEN 3 
        ELSE 4 
      END,
      score DESC`,
    [reportId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Obter cliente específico com roteiro
app.get('/api/clients/:clientId', authMiddleware, (req, res) => {
  const { clientId } = req.params;
  
  db.get('SELECT * FROM clients WHERE id = ?', [clientId], (err, client) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });
    
    // Gerar roteiro personalizado
    const roteiro = gerarRoteiro(client);
    res.json({ ...client, roteiro });
  });
});

// Registrar resultado do atendimento
app.post('/api/clients/:clientId/result', authMiddleware, (req, res) => {
  const { clientId } = req.params;
  const { resultado, valor_venda, motivo_perda, usou_roteiro, notas } = req.body;
  
  // Calcular tickets
  let tickets = 1; // registrou
  if (usou_roteiro === 'sim') tickets += 1;
  if (usou_roteiro === 'adaptado') tickets += 1;
  if (resultado === 'venda') tickets += 5;
  if (resultado === 'follow-up') tickets += 2;
  
  db.run(`UPDATE clients SET 
    status = 'contactado',
    resultado = ?,
    valor_venda = ?,
    motivo_perda = ?,
    usou_roteiro = ?,
    data_interacao = CURRENT_TIMESTAMP,
    tickets = ?
    WHERE id = ?`,
    [resultado, valor_venda, motivo_perda, usou_roteiro, tickets, clientId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Atualizar ranking
      atualizarRanking(req.userId, tickets, resultado === 'venda' ? 1 : 0);
      
      res.json({ success: true, tickets });
    }
  );
});

// ========== ROTAS DE DASHBOARD ==========

// Dashboard do gerente
app.get('/api/dashboard', authMiddleware, (req, res) => {
  const gerenteId = req.userId;
  
  db.get(`SELECT 
    (SELECT COUNT(DISTINCT report_id) FROM clients c 
     JOIN reports r ON c.report_id = r.id WHERE r.gerente_id = ?) as total_relatorios,
    (SELECT COUNT(*) FROM clients c 
     JOIN reports r ON c.report_id = r.id WHERE r.gerente_id = ?) as total_clientes,
    (SELECT COUNT(*) FROM clients c 
     JOIN reports r ON c.report_id = r.id WHERE r.gerente_id = ? AND c.status = 'contactado') as contactados,
    (SELECT COUNT(*) FROM clients c 
     JOIN reports r ON c.report_id = r.id WHERE r.gerente_id = ? AND c.resultado = 'venda') as vendas,
    (SELECT COALESCE(SUM(tickets), 0) FROM clients c 
     JOIN reports r ON c.report_id = r.id WHERE r.gerente_id = ?) as total_tickets
  `, [gerenteId, gerenteId, gerenteId, gerenteId, gerenteId], (err, stats) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // Ranking
    db.all(`SELECT u.nome, r.tickets, r.vendas, r.posicao 
      FROM ranking r JOIN users u ON r.gerente_id = u.id
      WHERE r.semana = ? ORDER BY r.posicao`,
      [getSemanaAtual()], (err, ranking) => {
        res.json({ stats, ranking });
      }
    );
  });
});

// ========== FUNÇÕES AUXILIARES ==========

function calcularDias(dataSimulacao) {
  const hoje = new Date();
  const simulacao = new Date(dataSimulacao);
  return Math.floor((hoje - simulacao) / (1000 * 60 * 60 * 24));
}

function calcularScore(valor, prazo, dias) {
  let score = 100;
  score -= dias * 2; // perde 2 pontos por dia
  if (valor > 100000) score += 10;
  if (prazo < 60) score += 10;
  if (prazo > 100) score -= 5;
  return Math.max(0, Math.min(100, score));
}

function detectarArquetipo(valor, prazo) {
  if (valor > 100000 && prazo < 80) return 'Realizador de Sonhos';
  if (valor > 80000 && prazo >= 80) return 'Planejador Estratégico';
  if (prazo < 60) return 'Precisa Agora';
  if (valor < 50000) return 'Cauteloso';
  return 'Indefinido';
}

function definirPrioridade(score, dias) {
  if (score >= 85 && dias <= 3) return 'hoje';
  if (score >= 70 && dias <= 7) return 'semana';
  if (score >= 50) return 'mes';
  return 'baixa';
}

function gerarRoteiro(cliente) {
  const roteiros = {
    'Realizador de Sonhos': {
      abertura: Oi ${cliente.nome}, sou do Banco do Brasil. Vi que você simulou ${cliente.valor_simulado?.toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'})} no consórcio. Posso te mostrar como garantir esse plano?,
      pergunta1: 'O que te levou a escolher esse valor?',
      pergunta2: 'Quando você gostaria de realizar esse sonho?',
      objecaoTaxa: 'Você prefere pagar menos de taxa ou ter o que deseja no momento certo?',
      objecaoPensar: 'Claro, só para eu entender: o que falta para você se sentir seguro?'
    },
    'Planejador Estratégico': {
      abertura: Oi ${cliente.nome}, sou do Banco do Brasil. Vi sua simulação de ${cliente.valor_simulado?.toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'})}. Vou mostrar como esse plano se encaixa no seu orçamento.,
      pergunta1: 'Como você planeja organizar esse investimento?',
      pergunta2: 'Qual segurança você busca nesse planejamento?',
      objecaoTaxa: 'Vamos comparar o custo total. O que importa é o valor final, não só a taxa.',
      objecaoPensar: 'Quais informações você precisa para tomar essa decisão com segurança?'
    },
    'Precisa Agora': {
      abertura: Oi ${cliente.nome}, sou do Banco do Brasil. Vi sua simulação e identifiquei uma oportunidade de agilidade. Posso te mostrar?,
      pergunta1: 'Qual a urgência para você resolver isso?',
      pergunta2: 'O que acontece se você não resolver agora?',
      objecaoTaxa: 'A velocidade de contemplação pode valer mais que a diferença de taxa.',
      objecaoPensar: 'Quanto tempo você pode esperar?'
    },
    'Cauteloso': {
      abertura: Oi ${cliente.nome}, sou do Banco do Brasil. Vi sua simulação e vou construir um plano seguro com você.,
      pergunta1: 'O que é mais importante para você: segurança ou velocidade?',
      pergunta2: 'Como você se sentiria com um plano sem juros e sem entrada?',
      objecaoTaxa: 'Vamos calcular junto: quanto você economiza sem juros?',
      objecaoPensar: 'Sem pressa. Que informações você precisa para se sentir tranquilo?'
    }
  };
  
  return roteiros[cliente.arquetipo] || roteiros['Realizador de Sonhos'];
}

function getSemanaAtual() {
  const hoje = new Date();
  return ${hoje.getFullYear()}-W${Math.ceil((hoje.getDate() + 6 - hoje.getDay()) / 7)};
}

function atualizarRanking(gerenteId, tickets, vendas) {
  const semana = getSemanaAtual();
  
  db.get('SELECT * FROM ranking WHERE gerente_id = ? AND semana = ?', 
    [gerenteId, semana], (err, row) => {
      if (row) {
        db.run('UPDATE ranking SET tickets = tickets + ?, vendas = vendas + ? WHERE id = ?',
          [tickets, vendas, row.id]);
      } else {
        db.run('INSERT INTO ranking (gerente_id, semana, tickets, vendas) VALUES (?, ?, ?, ?)',
          [gerenteId, semana, tickets, vendas]);
      }
      
      // Recalcular posições
      db.all('SELECT id FROM ranking WHERE semana = ? ORDER BY tickets DESC', [semana], (err, rows) => {
        rows.forEach((row, index) => {
          db.run('UPDATE ranking SET posicao = ? WHERE id = ?', [index + 1, row.id]);
        });
      });
    }
  );
}

// Iniciar servidor
app.listen(PORT, () => {
  console.log(🚀 NURONIS SALES OS rodando na porta ${PORT});
  console.log(📱 Acesse: http://localhost:${PORT});
});
