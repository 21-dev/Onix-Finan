/* Onix Finan — aplicação financeira responsiva em Vanilla JavaScript. */
'use strict';

const SUPABASE_URL = 'https://dlsszwdqxbpeadvdyuyz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRsc3N6d2RxeGJwZWFkdmR5dXl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzMDkxNzUsImV4cCI6MjA5ODg4NTE3NX0.TBNVYNcus8B7tCwI98oUVLHWcZ7M0GLqHa-MB1COfq8';
const SUPABASE_TABLE = 'onix_finance_state';
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const EXPENSE_CATEGORIES = ['Alimentação','Transporte','Moradia','Saúde','Mercado','Assinaturas','Lazer','Educação','Outros'];
const INCOME_CATEGORIES = ['Salário','Bônus','Décimo terceiro','Investimentos','Reembolso','Outros'];
const NAV_ITEMS = [
    { id:'home', label:'Home', icon:'layout-dashboard' },
    { id:'cards', label:'Cartões', icon:'credit-card' },
    { id:'new', label:'Novo registro', icon:'plus-circle' },
    { id:'settings', label:'Configurações', icon:'settings-2' }
];

let supabaseClient = null;
let syncTimer = null;
let currentView = 'home';
let currentRecordTab = 'expense';
let editingRecordId = null;
let editingRecordSourceView = 'home';
let currentDate = new Date();
let user = null;
let state = createDefaultState();
const pendingButtonActions = new Map();

function createDefaultState() {
    return {
        version: 3,
        records: [],
        cards: [],
        goals: { name: 'Viagem de férias', target: 0, saved: 0, categoryLimits: {} },
        invoicePayments: {},
        profile: { name:'Usuário', email:'', phone:'', birth:'', salary:0, payday:5, advanceDay:null, currency:'BRL', invoiceCycle:'pagamento' }
    };
}

const $ = id => document.getElementById(id);
const renderIcons = () => window.lucide?.createIcons();
const uid = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[char]));
const monthKey = (month = currentDate.getMonth(), year = currentDate.getFullYear()) => `${year}-${String(month + 1).padStart(2,'0')}`;
const todayIso = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0,10);
const addMonths = (date, amount) => { const [y,m,d] = date.split('-').map(Number); const result = new Date(y, m - 1 + amount, Math.min(d, 28), 12); return result.toISOString().slice(0,10); };
const valueOf = item => Number(item.tipo === 'cartao' ? item.valor_parcela : item.valor) || 0;
const cardMatchesPurchase = (card,item) => item.tipo==='cartao'&&(String(item.cardId||'')===String(card.id)||(!item.cardId&&String(item.cartao_nome||'').toLowerCase()===String(card.name).toLowerCase()));
const purchaseIsPaid = (card,item) => Boolean(item.status_pagamento||state.invoicePayments[`${String(item.data||'').slice(0,7)}_${card.id}`]);
const recordsForMonth = () => state.records.filter(item => String(item.data || '').slice(0,7) === monthKey());
const formatDate = value => value ? new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short'}).format(new Date(`${value}T12:00:00`)) : '-';
const money = value => new Intl.NumberFormat('pt-BR',{style:'currency',currency:state.profile.currency || 'BRL'}).format(Number(value)||0);

function getClient() {
    if (!supabaseClient && window.supabase) supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return supabaseClient;
}

function normalizeState(payload = {}) {
    const base = createDefaultState();
    const legacyProfile = payload.usuario || payload.profile || {};
    const legacyGoals = payload.metas || payload.goals || {};
    return {
        ...base,
        records: Array.isArray(payload.records) ? payload.records : Array.isArray(payload.despesas) ? payload.despesas : [],
        cards: (Array.isArray(payload.cards) ? payload.cards : Array.isArray(payload.cartoes) ? payload.cartoes : []).map(card => ({ id:card.id || uid('card'), name:card.name || card.nome, limit:Number(card.limit ?? card.limite) || 0, closingDay:Number(card.closingDay ?? card.fechamento) || 1, dueDay:Number(card.dueDay ?? card.vencimento) || 1, invoiceCycle:card.invoiceCycle || card.cicloFatura || null })),
        goals: { name:legacyGoals.name || 'Reserva financeira', target:Number(legacyGoals.target ?? legacyGoals.economiaMensal) || 0, saved:Number(legacyGoals.saved) || 0, categoryLimits:legacyGoals.categoryLimits || legacyGoals.limitesCategoria || {} },
        invoicePayments: payload.invoicePayments || {},
        profile: {
            ...base.profile,
            ...legacyProfile,
            name:legacyProfile.name || legacyProfile.nome || base.profile.name,
            email:legacyProfile.email || '', phone:legacyProfile.phone || legacyProfile.telefone || '', birth:legacyProfile.birth || legacyProfile.nascimento || '',
            salary:Number(legacyProfile.salary ?? legacyProfile.salario) || 0, payday:Number(legacyProfile.payday ?? legacyProfile.diaPagamento) || 5,
            advanceDay:Number(legacyProfile.advanceDay ?? legacyProfile.diaAdiantamento) || null, currency:legacyProfile.currency || legacyProfile.moeda || 'BRL', invoiceCycle:legacyProfile.invoiceCycle || 'pagamento'
        }
    };
}

function userStorageKey() { return `onix_finance_v3_${user?.id || 'local'}`; }
function legacyKey(prefix) { return `${prefix}_${user?.id || 'anon'}`; }

function loadLocalState() {
    const modern = localStorage.getItem(userStorageKey());
    if (modern) return normalizeState(JSON.parse(modern));
    return normalizeState({
        despesas: JSON.parse(localStorage.getItem(legacyKey('finances_data_v2')) || '[]'),
        cartoes: JSON.parse(localStorage.getItem(legacyKey('finances_cards_v1')) || '[]'),
        metas: JSON.parse(localStorage.getItem(legacyKey('finances_goals_v1')) || '{}'),
        usuario: user ? profileFromAuth(user) : {}
    });
}

function payload() { return { version:3, updatedAt:new Date().toISOString(), records:state.records, cards:state.cards, goals:state.goals, invoicePayments:state.invoicePayments, profile:state.profile }; }
function saveState() {
    localStorage.setItem(userStorageKey(), JSON.stringify(payload()));
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncCloud, 700);
}

async function loadState() {
    state = loadLocalState();
    try {
        const { data, error } = await getClient().from(SUPABASE_TABLE).select('payload').eq('user_id', user.id).maybeSingle();
        if (error) throw error;
        if (data?.payload) state = normalizeState(data.payload);
    } catch (error) { console.warn('Supabase indisponível; usando armazenamento local.', error); showToast('Modo local ativado. A nuvem está indisponível.'); }
    state.profile = { ...state.profile, ...profileFromAuth(user), invoiceCycle:state.profile.invoiceCycle || 'pagamento' };
    ensureAutomaticIncome();
    saveState();
}

async function syncCloud() {
    if (!user || !getClient()) return;
    try { await getClient().from(SUPABASE_TABLE).upsert({ user_id:user.id, payload:payload(), updated_at:new Date().toISOString() }, { onConflict:'user_id' }); }
    catch (error) { console.warn('Falha ao sincronizar.', error); }
}

function profileFromAuth(authUser) {
    const meta = authUser?.user_metadata || {};
    return { name:meta.name || meta.nome || authUser?.email?.split('@')[0] || 'Usuário', email:authUser?.email || '', phone:meta.phone || meta.telefone || '', birth:meta.birth || meta.nascimento || '', salary:Number(meta.salary ?? meta.salario) || 0, payday:Number(meta.payday ?? meta.diaPagamento) || 5, advanceDay:Number(meta.advanceDay ?? meta.diaAdiantamento) || null, currency:meta.currency || meta.moeda || 'BRL' };
}

async function initAuth() {
    const client = getClient();
    if (!client) { showAuth(); $('auth-status').textContent = 'Não foi possível carregar a autenticação.'; return; }
    const { data } = await client.auth.getSession();
    if (data.session?.user) await enterApp(data.session.user); else showAuth();
}

function showAuth() { $('auth-screen').classList.remove('hidden'); $('auth-screen').classList.add('flex'); $('app-shell').classList.add('hidden'); renderIcons(); }
async function enterApp(authUser) { user = authUser; $('auth-screen').classList.add('hidden'); $('auth-screen').classList.remove('flex'); $('app-shell').classList.remove('hidden'); await loadState(); setupApp(); }

function setupAuthEvents() {
    $('auth-tab-login').onclick = () => setAuthTab('login'); $('auth-tab-register').onclick = () => setAuthTab('register');
    $('login-form').onsubmit = async event => { event.preventDefault(); const { data,error } = await getClient().auth.signInWithPassword({ email:$('login-email').value.trim(), password:$('login-password').value }); if(error) return showToast(error.message); await enterApp(data.user); };
    $('register-form').onsubmit = async event => { event.preventDefault(); const name=$('register-name').value.trim(), email=$('register-email').value.trim(), password=$('register-password').value; const {data,error}=await getClient().auth.signUp({email,password,options:{data:{name}}}); if(error) return showToast(error.message); if(!data.session) return showToast('Confirme o cadastro pelo e-mail.'); await enterApp(data.user); };
    $('recover-password').onclick = async () => { const email=$('login-email').value.trim(); if(!email) return showToast('Informe o e-mail primeiro.'); const {error}=await getClient().auth.resetPasswordForEmail(email,{redirectTo:location.href.split('#')[0]}); showToast(error ? error.message : 'Link de recuperação enviado.'); };
}

function setAuthTab(tab) { const login=tab==='login'; $('login-form').classList.toggle('hidden',!login); $('register-form').classList.toggle('hidden',login); $('auth-tab-login').className=`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${login?'bg-white shadow-sm':'text-gray-500'}`; $('auth-tab-register').className=`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${!login?'bg-white shadow-sm':'text-gray-500'}`; }

function setupApp() {
    renderNavigation(); populateForms(); bindStaticEvents(); navigate(currentView);
    $('sidebar-user').textContent = state.profile.name;
}

function renderNavigation() {
    const desktop = NAV_ITEMS.map(navButton).join('');
    $('desktop-nav').innerHTML = desktop; $('mobile-menu').innerHTML = desktop;
    $('bottom-nav').innerHTML = NAV_ITEMS.map(item => `<button data-view="${item.id}" class="nav-link flex flex-col items-center gap-1 rounded-xl py-1.5 text-[10px] font-semibold text-gray-400"><i data-lucide="${item.icon}" class="h-5 w-5"></i>${item.label.replace('Novo registro','Novo')}</button>`).join('');
    document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => navigate(button.dataset.view));
}
function navButton(item) { return `<button data-view="${item.id}" class="nav-link flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-gray-500 hover:bg-gray-50"><i data-lucide="${item.icon}" class="h-5 w-5"></i>${item.label}</button>`; }

function navigate(view,preserveRecordEdit=false) {
    if(!preserveRecordEdit && editingRecordId) resetRecordEditMode();
    currentView=view; document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',el.id===`view-${view}`));
    document.querySelectorAll('.nav-link').forEach(el=>{ const active=el.dataset.view===view; el.classList.toggle('bg-ink',active); el.classList.toggle('text-white',active); el.classList.toggle('text-gray-500',!active); });
    $('mobile-menu').classList.add('hidden');
    if(view==='home') renderHome(); if(view==='cards') renderCards(); if(view==='settings') fillSettings();
    renderIcons(); window.scrollTo({top:0,behavior:'smooth'});
}

function bindStaticEvents() {
    $('mobile-menu-button').onclick=()=>$('mobile-menu').classList.toggle('hidden');
    $('theme-toggle').onclick=toggleTheme; $('mobile-theme-toggle').onclick=toggleTheme;
    $('logout-button').onclick=async()=>{ await syncCloud(); await getClient().auth.signOut(); user=null; showAuth(); };
    $('expense-method').onchange=toggleExpenseMethod;
    $('expense-form').onsubmit=saveExpense; $('income-form').onsubmit=saveIncome; $('card-form').onsubmit=saveCard; $('settings-form').onsubmit=saveSettings;
}

function applyTheme(theme = localStorage.getItem('onix_theme') || 'light') {
    const dark=theme==='dark'; document.documentElement.classList.toggle('dark',dark);
    if($('theme-label')) $('theme-label').textContent=dark?'Claro':'Escuro';
    localStorage.setItem('onix_theme',dark?'dark':'light'); renderIcons();
}
function toggleTheme() { applyTheme(document.documentElement.classList.contains('dark')?'light':'dark'); }

function populateForms() {
    $('expense-category').innerHTML=EXPENSE_CATEGORIES.map(option).join(''); $('income-category').innerHTML=INCOME_CATEGORIES.map(option).join('');
    $('expense-date').value=$('income-date').value=todayIso(); renderRecordTabs(); updateCardOptions();
}
const option = value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;

function renderRecordTabs() {
    const tabs=[['expense','Despesa'],['income','Receita'],['card','Cartão']];
    $('record-tabs').innerHTML=tabs.map(([id,label])=>`<button type="button" data-record-tab="${id}" class="flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${currentRecordTab===id?'bg-white shadow-sm':'text-gray-500'}">${label}</button>`).join('');
    document.querySelectorAll('[data-record-tab]').forEach(button=>button.onclick=()=>setRecordTab(button.dataset.recordTab));
}
function setRecordTab(tab) { currentRecordTab=tab; document.querySelectorAll('.record-form').forEach(form=>form.classList.toggle('hidden',form.id!==`${tab}-form`)); renderRecordTabs(); }
function toggleExpenseMethod() { const card=$('expense-method').value==='cartao'; $('expense-card-fields').classList.toggle('hidden',!card); $('expense-cycle-wrap').classList.toggle('hidden',card); $('expense-repeat-wrap').classList.toggle('hidden',card); }
function updateCardOptions() { $('expense-card').innerHTML=state.cards.length?state.cards.map(card=>`<option value="${card.id}">${escapeHtml(card.name)}</option>`).join(''):'<option value="">Cadastre um cartão</option>'; }

function ensureAutomaticIncome() {
    const key=monthKey(), profile=state.profile;
    state.records=state.records.filter(item=>!(item.autoMonth===key));
    if(!profile.salary) return;
    const dateFor=day=>`${key}-${String(Math.min(Number(day)||1,new Date(currentDate.getFullYear(),currentDate.getMonth()+1,0).getDate())).padStart(2,'0')}`;
    if(profile.advanceDay && profile.advanceDay!==profile.payday) {
        state.records.push({id:`auto_${key}_advance`,autoMonth:key,tipo:'receita',descricao:'Adiantamento',valor:profile.salary*.4,data:dateFor(profile.advanceDay),categoria:'Salário',status_pagamento:true},{id:`auto_${key}_salary`,autoMonth:key,tipo:'receita',descricao:'Pagamento',valor:profile.salary*.6,data:dateFor(profile.payday),categoria:'Salário',status_pagamento:true});
    } else state.records.push({id:`auto_${key}_salary`,autoMonth:key,tipo:'receita',descricao:'Salário',valor:profile.salary,data:dateFor(profile.payday),categoria:'Salário',status_pagamento:true});
}

function invoiceItems() {
    return state.cards.map(card=>{ const purchases=recordsForMonth().filter(item=>item.tipo==='cartao' && (String(item.cardId||'')===String(card.id) || (!item.cardId && String(item.cartao_nome||'').toLowerCase()===String(card.name).toLowerCase()))); const total=purchases.reduce((sum,item)=>sum+valueOf(item),0); const key=`${monthKey()}_${card.id}`; const paid=Boolean(state.invoicePayments[key]) || (purchases.length>0 && purchases.every(item=>item.status_pagamento)); return {id:`invoice_${key}`,invoiceKey:key,card,purchases,total,status_pagamento:paid,data:`${monthKey()}-${String(Math.min(card.dueDay,28)).padStart(2,'0')}`,descricao:`Fatura ${card.name}`,ciclo:card.invoiceCycle || state.profile.invoiceCycle || 'pagamento'}; }).filter(item=>item.total>0);
}

function renderHome() {
    const monthly=recordsForMonth(), incomes=monthly.filter(i=>i.tipo==='receita'), standard=monthly.filter(i=>i.tipo!=='receita'&&i.tipo!=='cartao'), invoices=invoiceItems();
    const paidStandard=standard.filter(i=>i.status_pagamento), pendingStandard=standard.filter(i=>!i.status_pagamento), paidInvoices=invoices.filter(i=>i.status_pagamento), pendingInvoices=invoices.filter(i=>!i.status_pagamento);
    const revenue=incomes.reduce((s,i)=>s+valueOf(i),0), paid=paidStandard.reduce((s,i)=>s+valueOf(i),0)+paidInvoices.reduce((s,i)=>s+i.total,0), pending=pendingStandard.reduce((s,i)=>s+valueOf(i),0)+pendingInvoices.reduce((s,i)=>s+i.total,0);
    const available=revenue-paid;
    const cycleItems=cycle=>[...pendingStandard.filter(i=>(i.ciclo||'pagamento')===cycle),...pendingInvoices.filter(i=>i.ciclo===cycle)];
    const history=[...paidStandard,...paidInvoices].sort((a,b)=>String(b.paymentDate||b.data).localeCompare(String(a.paymentDate||a.data)));
    const incomeHistory=[...incomes].sort((a,b)=>String(b.data).localeCompare(String(a.data)));
    const goalPercent=state.goals.target?Math.min(state.goals.saved/state.goals.target*100,100):0;
    $('view-home').innerHTML=`
        <div class="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p class="text-xs font-bold uppercase tracking-widest text-sage-700">Visão geral</p><h1 class="mt-1 text-2xl font-bold">Olá, ${escapeHtml(state.profile.name.split(' ')[0])}</h1></div><p class="text-xs text-gray-400">Pagamento, edição e exclusão pedem dois cliques ou toques.</p></div>
        <section class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-7"><div class="flex items-center justify-between"><button data-month-nav="-1" class="mobile-action rounded-lg p-2 hover:bg-gray-100"><i data-lucide="chevron-left"></i></button><strong class="px-2 text-center text-sm sm:text-base">${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}</strong><button data-month-nav="1" class="mobile-action rounded-lg p-2 hover:bg-gray-100"><i data-lucide="chevron-right"></i></button></div><div class="mt-5 grid grid-cols-2 gap-3 sm:mt-6 sm:gap-4 xl:grid-cols-4">${summaryCard('Saldo disponível',money(available),'wallet','sage')}${summaryCard('Receitas',money(revenue),'trending-up','blue')}${summaryCard('Despesas pendentes',money(pending),'clock-3','amber')}${summaryCard('Saldo projetado',money(available-pending),'chart-no-axes-combined',available-pending>=0?'gray':'red')}</div></section>
        <div class="mt-6 grid gap-6 xl:grid-cols-2">${renderCycle('Ciclo de Pagamento',cycleItems('pagamento'),'Pagamento')}${renderCycle('Ciclo de Adiantamento',cycleItems('adiantamento'),'Adiantamento')}</div>
        <div class="mt-6 grid gap-6 xl:grid-cols-3"><section class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><div class="flex items-center justify-between"><div><p class="text-xs text-gray-400">Meta</p><h2 class="mt-1 font-bold">${escapeHtml(state.goals.name)}</h2></div><span class="text-sm font-bold text-sage-700">${goalPercent.toFixed(0)}%</span></div><div class="mt-5 h-2.5 overflow-hidden rounded-full bg-gray-100"><div class="h-full rounded-full bg-sage-500" style="width:${goalPercent}%"></div></div><div class="mt-3 flex justify-between text-xs text-gray-500"><span>${money(state.goals.saved)}</span><span>${money(state.goals.target)}</span></div></section><section class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><div class="flex items-center justify-between"><h2 class="font-bold">Histórico de despesas</h2><span class="text-xs text-gray-400">${history.length} itens</span></div><div class="mt-3 max-h-72 divide-y divide-gray-100 overflow-y-auto scrollbar">${history.length?history.map(renderHistory).join(''):empty('Nenhum pagamento neste mês.')}</div></section><section class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><div class="flex items-center justify-between"><h2 class="font-bold">Histórico de receitas</h2><span class="text-xs font-semibold text-emerald-600">${money(revenue)}</span></div><div class="mt-3 max-h-72 divide-y divide-gray-100 overflow-y-auto scrollbar">${incomeHistory.length?incomeHistory.map(renderIncomeHistory).join(''):empty('Nenhuma receita neste mês.')}</div></section></div>`;
    document.querySelectorAll('[data-month-nav]').forEach(button=>button.onclick=()=>changeMonth(Number(button.dataset.monthNav)));
    bindConfirmButtons(); renderIcons();
}

function summaryCard(label,value,icon,tone) { const colors={sage:'from-emerald-100 to-sage-50 text-sage-700 ring-emerald-100',blue:'from-sky-100 to-slate-50 text-slate-700 ring-sky-100',amber:'from-amber-100 to-orange-50 text-amber-700 ring-amber-100',gray:'from-violet-100 to-slate-50 text-slate-700 ring-violet-100',red:'from-rose-100 to-red-50 text-red-600 ring-rose-100'}; return `<div class="summary-card group relative min-w-0 overflow-hidden rounded-xl border border-gray-100 bg-gradient-to-br from-white to-gray-50/70 p-3 transition hover:-translate-y-0.5 hover:shadow-md sm:rounded-2xl sm:p-4"><div class="absolute -right-5 -top-5 h-20 w-20 rounded-full bg-gray-100/60 blur-xl"></div><div class="relative flex items-start justify-between"><div class="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br ${colors[tone]} shadow-sm ring-1 sm:h-11 sm:w-11 sm:rounded-xl"><i data-lucide="${icon}" class="h-4 w-4 sm:h-5 sm:w-5" stroke-width="1.8"></i></div><i data-lucide="sparkles" class="hidden h-4 w-4 text-gray-200 transition group-hover:text-sage-400 sm:block"></i></div><p class="summary-label relative mt-3 text-[11px] font-medium leading-tight text-gray-400 sm:mt-4 sm:text-xs">${label}</p><strong class="summary-value relative mt-1 block truncate text-lg tracking-tight sm:text-xl" title="${value}">${value}</strong></div>`; }
function renderCycle(title,items,badge) { const total=items.reduce((sum,item)=>sum+(item.invoiceKey?item.total:valueOf(item)),0); return `<section class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><div class="flex items-start justify-between gap-3"><div><h2 class="font-bold">${title}</h2><p class="mt-1 text-xs text-gray-400">${items.length} conta(s) pendente(s)</p></div><div class="text-right"><span class="block text-[10px] uppercase tracking-wide text-gray-400">Total do ciclo</span><strong class="mt-1 block text-lg">${money(total)}</strong></div></div><div class="mt-3 divide-y divide-gray-100">${items.length?items.map(item=>renderPending(item,badge)).join(''):empty('Nenhuma conta pendente.')}</div></section>`; }
function renderPending(item,badge) { const invoice=Boolean(item.invoiceKey), value=invoice?item.total:valueOf(item); return `<div class="group flex items-center gap-3 py-3.5"><div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl ${invoice?'bg-slate-100 text-slate-600':'bg-amber-50 text-amber-700'}"><i data-lucide="${invoice?'credit-card':'receipt-text'}" class="h-4 w-4"></i></div><div class="min-w-0 flex-1"><strong class="block truncate text-sm">${escapeHtml(item.descricao)}</strong><span class="text-[11px] text-gray-400">${formatDate(item.data)} · ${badge}</span></div><strong class="text-sm">${money(value)}</strong><div class="flex gap-1"><button data-confirm-action="pay" data-id="${item.id}" class="rounded-lg bg-sage-50 p-2 text-sage-700" title="Pagar"><i data-lucide="check" class="h-4 w-4"></i></button><button data-confirm-action="${invoice?'edit-invoice':'edit-record'}" data-id="${item.id}" class="rounded-lg bg-gray-100 p-2 text-gray-500" title="Editar"><i data-lucide="pencil" class="h-4 w-4"></i></button>${!invoice?`<button data-double-action="delete-record" data-id="${item.id}" class="rounded-lg p-2 text-gray-300 hover:text-red-500" title="Excluir"><i data-lucide="trash-2" class="h-4 w-4"></i></button>`:''}</div></div>`; }
function renderHistory(item) { const value=item.invoiceKey?item.total:valueOf(item), editAction=item.invoiceKey?'edit-invoice':'edit-record'; return `<div class="flex items-center gap-3 py-3"><div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-100 to-sage-50 text-sage-700 ring-1 ring-emerald-100"><i data-lucide="badge-check" class="h-4 w-4"></i></div><div class="min-w-0 flex-1"><strong class="block truncate text-sm">${escapeHtml(item.descricao)}</strong><span class="text-[11px] text-gray-400">Pago em ${formatDate(item.paymentDate||item.data)}</span></div><span class="text-sm font-semibold text-gray-600">${money(value)}</span><div class="flex gap-1"><button data-confirm-action="${editAction}" data-id="${item.id}" class="rounded-lg bg-gray-100 p-2 text-gray-500 hover:text-sage-700" title="Editar"><i data-lucide="square-pen" class="h-4 w-4"></i></button>${!item.invoiceKey?`<button data-double-action="delete-record" data-id="${item.id}" class="rounded-lg p-2 text-gray-300 hover:bg-red-50 hover:text-red-500" title="Excluir"><i data-lucide="trash-2" class="h-4 w-4"></i></button>`:''}</div></div>`; }
function renderIncomeHistory(item) { return `<div class="flex items-center gap-3 py-3"><div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-100 to-green-50 text-emerald-600 ring-1 ring-emerald-100"><i data-lucide="circle-dollar-sign" class="h-4 w-4"></i></div><div class="min-w-0 flex-1"><strong class="block truncate text-sm">${escapeHtml(item.descricao)}</strong><span class="text-[11px] text-gray-400">${formatDate(item.data)} · ${escapeHtml(item.categoria||'Receita')}</span></div><strong class="text-sm text-emerald-600">+${money(valueOf(item))}</strong>${!item.autoMonth?`<div class="flex gap-1"><button data-confirm-action="edit-record" data-id="${item.id}" class="rounded-lg bg-gray-100 p-2 text-gray-500 hover:text-sage-700" title="Editar"><i data-lucide="square-pen" class="h-4 w-4"></i></button><button data-double-action="delete-record" data-id="${item.id}" class="rounded-lg p-2 text-gray-300 hover:bg-red-50 hover:text-red-500" title="Excluir"><i data-lucide="trash-2" class="h-4 w-4"></i></button></div>`:''}</div>`; }
const empty = text => `<p class="py-8 text-center text-sm text-gray-400">${text}</p>`;

function renderCards() {
    const invoices=invoiceItems();
    $('view-cards').innerHTML=`<div class="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p class="text-xs font-bold uppercase tracking-widest text-sage-700">Crédito</p><h1 class="mt-1 text-2xl font-bold">Cartões</h1><p class="mt-1 text-sm text-gray-500">Compras e faturas de ${MONTHS[currentDate.getMonth()]}</p></div><button id="add-card-purchase" class="rounded-xl bg-ink px-5 py-3 text-sm font-semibold text-white">Adicionar compra ou cartão</button></div><div class="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">${state.cards.length?state.cards.map(card=>renderCardWidget(card,invoices.find(i=>String(i.card.id)===String(card.id)))).join(''):empty('Nenhum cartão cadastrado.')}</div>`;
    $('add-card-purchase').onclick=()=>{navigate('new');setRecordTab(state.cards.length?'expense':'card');if(state.cards.length){$('expense-method').value='cartao';toggleExpenseMethod();}};
    document.querySelectorAll('[data-edit-card]').forEach(button=>button.onclick=()=>editCard(button.dataset.editCard)); bindConfirmButtons(); renderIcons();
}
function cardTheme(name='') { const key=name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); const themes=[[/nubank|\bnu\b/,'linear-gradient(135deg,#820ad1,#4c0677)','white'],[/inter/,'linear-gradient(135deg,#ff7a00,#d94f00)','white'],[/itau/,'linear-gradient(135deg,#ec7000,#003399)','white'],[/santander/,'linear-gradient(135deg,#ec0000,#9b0000)','white'],[/bradesco/,'linear-gradient(135deg,#cc092f,#8b001d)','white'],[/caixa/,'linear-gradient(135deg,#0066b3,#00a4e4)','white'],[/banco do brasil|\bbb\b/,'linear-gradient(135deg,#ffdf00,#1f4e9e)','#10264f'],[/c6/,'linear-gradient(135deg,#101010,#3b3b3b)','white'],[/picpay/,'linear-gradient(135deg,#21c25e,#087d38)','white'],[/mercado pago/,'linear-gradient(135deg,#00a9e0,#0072ce)','white'],[/xp/,'linear-gradient(135deg,#111,#b69335)','white']]; const found=themes.find(([regex])=>regex.test(key)); return found?{background:found[1],color:found[2]}:{background:'linear-gradient(135deg,#475569,#1e293b)',color:'white'}; }
function renderCardWidget(card,invoice) { const purchases=invoice?.purchases||[], total=invoice?.total||0, allPurchases=state.records.filter(item=>cardMatchesPurchase(card,item)), committed=allPurchases.filter(item=>!purchaseIsPaid(card,item)).reduce((sum,item)=>sum+valueOf(item),0), available=Math.max(card.limit-committed,0), pct=card.limit?Math.min(committed/card.limit*100,100):0,theme=cardTheme(card.name),cycle=card.invoiceCycle||state.profile.invoiceCycle||'pagamento'; return `<article class="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"><header class="p-5" style="background:${theme.background};color:${theme.color}"><div class="flex justify-between gap-3"><div><p class="text-xs opacity-70">Limite disponível após parcelas</p><strong class="mt-1 block text-xl">${money(available)}</strong><p class="mt-1 text-[10px] opacity-60">${money(committed)} comprometidos</p></div><div class="flex"><button data-edit-card="${card.id}" class="rounded-lg p-2 opacity-70 hover:bg-white/10 hover:opacity-100" title="Editar cartão"><i data-lucide="square-pen" class="h-4 w-4"></i></button><button data-double-action="delete-card" data-id="${card.id}" class="rounded-lg p-2 opacity-70 hover:bg-white/10 hover:opacity-100" title="Excluir cartão"><i data-lucide="trash-2" class="h-4 w-4"></i></button></div></div><div class="mt-7 flex items-end justify-between"><div><strong>${escapeHtml(card.name)}</strong><p class="mt-1 text-[10px] opacity-60">Fecha dia ${card.closingDay} · Vence dia ${card.dueDay}</p><span class="mt-2 inline-block rounded-full bg-white/15 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide">Ciclo de ${cycle}</span></div><i data-lucide="contactless" class="opacity-50"></i></div></header><div class="p-5"><div class="max-h-56 divide-y divide-gray-100 overflow-y-auto scrollbar">${purchases.length?purchases.map(item=>`<div class="flex items-center gap-3 py-3"><div class="min-w-0 flex-1"><strong class="block truncate text-sm">${escapeHtml(item.descricao)}</strong><span class="text-[11px] text-gray-400">${item.parcela_atual||1}/${item.quantidade_parcelas||1} · ${escapeHtml(item.categoria||'Outros')}</span></div><span class="text-sm font-semibold">${money(valueOf(item))}</span><div class="flex gap-1"><button data-confirm-action="edit-record" data-id="${item.id}" class="rounded-lg bg-gray-100 p-2 text-gray-500 hover:text-sage-700" title="Editar compra"><i data-lucide="square-pen" class="h-4 w-4"></i></button><button data-double-action="delete-record" data-id="${item.id}" class="rounded-lg p-2 text-gray-300 hover:bg-red-50 hover:text-red-500" title="Excluir compra"><i data-lucide="trash-2" class="h-4 w-4"></i></button></div></div>`).join(''):empty('Sem compras neste mês.')}</div><footer class="mt-4 border-t border-gray-100 pt-4"><div class="flex justify-between"><span class="text-sm text-gray-500">Total da fatura</span><strong>${money(total)}</strong></div><div class="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100"><div class="h-full bg-slate-500" style="width:${pct}%"></div></div></footer></div></article>`; }

function saveExpense(event) {
    event.preventDefault(); const description=$('expense-description').value.trim(), value=Number($('expense-value').value), date=$('expense-date').value, category=$('expense-category').value, method=$('expense-method').value, group=uid('group');
    if(editingRecordId) { const item=state.records.find(record=>String(record.id)===String(editingRecordId)); if(item){item.descricao=description;item.data=date;item.categoria=category;if(item.tipo==='cartao'){const card=state.cards.find(c=>String(c.id)===String($('expense-card').value));item.valor_parcela=value;item.cardId=card?.id||item.cardId;item.cartao_nome=card?.name||item.cartao_nome;const siblings=state.records.filter(record=>item.parent_id&&record.parent_id===item.parent_id);const updatedTotal=siblings.reduce((sum,record)=>sum+valueOf(record),0);siblings.forEach(record=>record.valor_total=updatedTotal);}else{item.valor=value;item.ciclo=$('expense-cycle').value;}} finishRecordEdit(event.target,item?.tipo==='cartao'?'Compra do cartão atualizada.':'Despesa atualizada.'); return; }
    if(method==='cartao') { const card=state.cards.find(c=>String(c.id)===String($('expense-card').value)); if(!card)return showToast('Cadastre e selecione um cartão.'); const installments=Math.max(1,Number($('expense-installments').value)||1), portion=value/installments; for(let i=0;i<installments;i++) state.records.push({id:uid('purchase'),parent_id:group,tipo:'cartao',cardId:card.id,cartao_nome:card.name,descricao:description,valor_total:value,valor_parcela:portion,quantidade_parcelas:installments,parcela_atual:i+1,data:addMonths(date,i),categoria:category,status_pagamento:false}); }
    else { const repeat=Math.max(1,Number($('expense-repeat').value)||1); for(let i=0;i<repeat;i++) state.records.push({id:uid('expense'),parent_id:group,tipo:'padrao',descricao:description,valor:value,data:addMonths(date,i),categoria:category,ciclo:$('expense-cycle').value,status_pagamento:false}); }
    saveState(); event.target.reset(); $('expense-date').value=todayIso(); $('expense-repeat').value=1; toggleExpenseMethod(); showToast('Despesa registrada.'); navigate('home');
}
function saveIncome(event) { event.preventDefault(); const repeat=Math.max(1,Number($('income-repeat').value)||1), group=uid('group'), description=$('income-description').value.trim(), value=Number($('income-value').value), date=$('income-date').value, category=$('income-category').value; if(editingRecordId){const item=state.records.find(record=>String(record.id)===String(editingRecordId));if(item){item.descricao=description;item.valor=value;item.data=date;item.categoria=category;}finishRecordEdit(event.target,'Receita atualizada.');return;} for(let i=0;i<repeat;i++)state.records.push({id:uid('income'),parent_id:group,tipo:'receita',descricao:description,valor:value,data:addMonths(date,i),categoria:category,status_pagamento:true}); saveState();event.target.reset();$('income-date').value=todayIso();$('income-repeat').value=1;showToast('Receita registrada.');navigate('home'); }
function saveCard(event) { event.preventDefault(); const id=$('card-edit-id').value||uid('card'), card={id,name:$('card-name').value.trim(),limit:Number($('card-limit').value),closingDay:Number($('card-close').value),dueDay:Number($('card-due').value),invoiceCycle:$('card-cycle').value}; const index=state.cards.findIndex(c=>String(c.id)===String(id)); if(index>=0)state.cards[index]=card;else state.cards.push(card); saveState();event.target.reset();$('card-edit-id').value='';updateCardOptions();showToast('Cartão salvo.');navigate('cards'); }
function editCard(id) { const card=state.cards.find(c=>String(c.id)===String(id)); if(!card)return; navigate('new');setRecordTab('card');$('card-edit-id').value=card.id;$('card-name').value=card.name;$('card-limit').value=card.limit;$('card-close').value=card.closingDay;$('card-due').value=card.dueDay;$('card-cycle').value=card.invoiceCycle||state.profile.invoiceCycle||'pagamento'; }

function startEditRecord(id) {
    const item=state.records.find(record=>String(record.id)===String(id)); if(!item)return;
    editingRecordId=item.id; editingRecordSourceView=currentView; navigate('new',true);
    if(item.tipo==='receita') { setRecordTab('income'); $('income-description').value=item.descricao;$('income-value').value=valueOf(item);$('income-date').value=item.data;$('income-category').value=item.categoria||'Outros';$('income-repeat').value=1;$('income-repeat').disabled=true;$('income-form').querySelector('button').textContent='Atualizar receita'; }
    else { const cardPurchase=item.tipo==='cartao'; setRecordTab('expense');$('expense-description').value=item.descricao;$('expense-value').value=valueOf(item);$('expense-date').value=item.data;$('expense-category').value=item.categoria||'Outros';$('expense-method').value=cardPurchase?'cartao':'padrao';$('expense-cycle').value=item.ciclo||'pagamento';$('expense-repeat').value=1;$('expense-repeat').disabled=true;$('expense-method').disabled=true;$('expense-card').value=item.cardId||'';$('expense-card').disabled=cardPurchase;$('expense-installments').value=item.quantidade_parcelas||1;$('expense-installments').disabled=cardPurchase;toggleExpenseMethod();$('expense-form').querySelector('button').textContent=cardPurchase?'Atualizar parcela':'Atualizar despesa'; }
}
function resetRecordEditMode() { editingRecordId=null;editingRecordSourceView='home';$('expense-repeat').disabled=false;$('expense-method').disabled=false;$('expense-card').disabled=false;$('expense-installments').disabled=false;$('income-repeat').disabled=false;$('expense-form').querySelector('button').textContent='Salvar despesa';$('income-form').querySelector('button').textContent='Salvar receita'; }
function finishRecordEdit(form,message) { const destination=editingRecordSourceView==='cards'?'cards':'home';saveState();editingRecordId=null;editingRecordSourceView='home';form.reset();$('expense-repeat').disabled=false;$('expense-method').disabled=false;$('expense-card').disabled=false;$('expense-installments').disabled=false;$('income-repeat').disabled=false;$('expense-form').querySelector('button').textContent='Salvar despesa';$('income-form').querySelector('button').textContent='Salvar receita';$('expense-date').value=$('income-date').value=todayIso();showToast(message);navigate(destination); }

function fillSettings() { const p=state.profile,g=state.goals; $('settings-name').value=p.name;$('settings-email').value=p.email;$('settings-phone').value=p.phone;$('settings-birth').value=p.birth;$('settings-currency').value=p.currency;$('settings-salary').value=p.salary||'';$('settings-payday').value=p.payday||5;$('settings-advance-day').value=p.advanceDay||'';$('settings-invoice-cycle').value=p.invoiceCycle||'pagamento';$('settings-goal-name').value=g.name;$('settings-goal-value').value=g.target||'';$('settings-goal-saved').value=g.saved||''; }
async function saveSettings(event) { event.preventDefault(); const previousEmail=state.profile.email; state.profile={...state.profile,name:$('settings-name').value.trim(),email:$('settings-email').value.trim(),phone:$('settings-phone').value.trim(),birth:$('settings-birth').value,salary:Number($('settings-salary').value)||0,payday:Number($('settings-payday').value)||5,advanceDay:Number($('settings-advance-day').value)||null,currency:$('settings-currency').value,invoiceCycle:$('settings-invoice-cycle').value}; state.goals={...state.goals,name:$('settings-goal-name').value.trim()||'Reserva financeira',target:Number($('settings-goal-value').value)||0,saved:Number($('settings-goal-saved').value)||0}; const authUpdate={data:{name:state.profile.name,phone:state.profile.phone,birth:state.profile.birth,salary:state.profile.salary,payday:state.profile.payday,advanceDay:state.profile.advanceDay,currency:state.profile.currency}}; if(state.profile.email!==previousEmail)authUpdate.email=state.profile.email;if($('settings-password').value)authUpdate.password=$('settings-password').value;const{error}=await getClient().auth.updateUser(authUpdate);if(error)return showToast(error.message);$('settings-password').value='';ensureAutomaticIncome();saveState();$('sidebar-user').textContent=state.profile.name;showToast('Configurações atualizadas.');renderHome(); }

function changeMonth(direction) { currentDate=new Date(currentDate.getFullYear(),currentDate.getMonth()+direction,1);ensureAutomaticIncome();saveState();renderHome(); }
function bindConfirmButtons() {
    // Migra os botões de exclusão antigos para o mesmo fluxo visual de confirmação.
    document.querySelectorAll('[data-double-action]').forEach(button=>{
        button.dataset.confirmAction=button.dataset.doubleAction;
        button.removeAttribute('data-double-action');
    });
    document.querySelectorAll('[data-confirm-action]').forEach(button=>button.onclick=event=>{
        event.stopPropagation(); const key=`${button.dataset.confirmAction}_${button.dataset.id}`, pending=pendingButtonActions.get(key), now=Date.now();
        if(pending && now-pending.time<3200) { pendingButtonActions.delete(key);button.className=pending.className;button.innerHTML=pending.html;renderIcons();executeConfirmAction(button.dataset.confirmAction,button.dataset.id); return; }
        clearPendingButtonActions(); const original={time:now,html:button.innerHTML,className:button.className,button}; pendingButtonActions.set(key,original);
        button.className='rounded-lg bg-amber-100 p-2 text-amber-700 ring-2 ring-amber-300'; button.innerHTML='<i data-lucide="triangle-alert" class="h-4 w-4"></i>'; renderIcons();
        setTimeout(()=>{if(pendingButtonActions.get(key)===original){pendingButtonActions.delete(key);button.className=original.className;button.innerHTML=original.html;renderIcons();}},3200);
    });
}
function clearPendingButtonActions() { pendingButtonActions.forEach(item=>{if(item.button?.isConnected){item.button.className=item.className;item.button.innerHTML=item.html;}});pendingButtonActions.clear();renderIcons(); }
function executeConfirmAction(action,id) { if(action==='pay')payItem(id); if(action==='edit-record')startEditRecord(id); if(action==='edit-invoice')navigate('cards'); if(action==='delete-record')deleteRecord(id); if(action==='delete-card')deleteCard(id); }
function payItem(id) { if(id.startsWith('invoice_')) { const invoice=invoiceItems().find(item=>item.id===id);if(!invoice)return;state.invoicePayments[invoice.invoiceKey]=true;invoice.purchases.forEach(p=>{p.status_pagamento=true;p.paymentDate=todayIso();}); } else { const item=state.records.find(r=>String(r.id)===String(id));if(item){item.status_pagamento=true;item.paymentDate=todayIso();} } saveState();showToast('Pagamento confirmado.');renderAll(); }
function deleteRecord(id) { state.records=state.records.filter(item=>String(item.id)!==String(id));saveState();showToast('Registro excluído.');renderAll(); }
function deleteCard(id) { const card=state.cards.find(item=>String(item.id)===String(id)); const hasPurchases=state.records.some(item=>item.tipo==='cartao'&&(String(item.cardId||'')===String(id)||(!item.cardId&&String(item.cartao_nome||'').toLowerCase()===String(card?.name||'').toLowerCase())));if(hasPurchases)return showToast('Exclua primeiro as compras vinculadas a este cartão.');state.cards=state.cards.filter(item=>String(item.id)!==String(id));saveState();updateCardOptions();showToast('Cartão excluído.');renderCards(); }
function renderAll() { if(currentView==='home')renderHome();if(currentView==='cards')renderCards();if(currentView==='settings')fillSettings();renderIcons(); }
function showToast(message) { const toast=document.createElement('div');toast.className='rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 shadow-lg';toast.textContent=message;$('toast-root').appendChild(toast);setTimeout(()=>toast.remove(),3200); }

document.addEventListener('DOMContentLoaded',()=>{applyTheme();setupAuthEvents();initAuth();});
