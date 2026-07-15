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
    { id:'goals', label:'Metas', icon:'target' },
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
let recoveryMode = false;
let appInitialized = false;
let state = createDefaultState();
const pendingButtonActions = new Map();

function createDefaultState() {
    return {
        version: 3,
        records: [],
        recurringTransactions: [],
        goalList: [],
        goalMovements: [],
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
const addMonths = (date, amount) => { const [y,m,d] = date.split('-').map(Number), target=new Date(y,m-1+amount,1,12), lastDay=new Date(target.getFullYear(),target.getMonth()+1,0).getDate(); return `${target.getFullYear()}-${String(target.getMonth()+1).padStart(2,'0')}-${String(Math.min(d,lastDay)).padStart(2,'0')}`; };
const addDays = (date,amount) => { const [y,m,d]=date.split('-').map(Number), target=new Date(y,m-1,d+amount,12); return `${target.getFullYear()}-${String(target.getMonth()+1).padStart(2,'0')}-${String(target.getDate()).padStart(2,'0')}`; };
const nextRecurringDate = (date,frequency) => frequency==='weekly'?addDays(date,7):frequency==='biweekly'?addDays(date,14):frequency==='yearly'?addMonths(date,12):addMonths(date,1);
const valueOf = item => Number(item.tipo === 'cartao' ? item.valor_parcela : item.valor) || 0;
const recordsInGroup = item => item?.parent_id ? state.records.filter(record=>record.parent_id===item.parent_id&&record.tipo===item.tipo) : item ? [item] : [];
const cardMatchesPurchase = (card,item) => item.tipo==='cartao'&&(String(item.cardId||'')===String(card.id)||(!item.cardId&&String(item.cartao_nome||'').toLowerCase()===String(card.name).toLowerCase()));
const invoiceMonthForPurchase = (card,item) => { const [year,month,day]=String(item.data||'').split('-').map(Number); if(!year||!month||!day)return ''; const invoiceMonth=new Date(year,month-1+(day>Number(card.closingDay)),1,12); return `${invoiceMonth.getFullYear()}-${String(invoiceMonth.getMonth()+1).padStart(2,'0')}`; };
const invoiceDueDate = (card,key) => { const [year,month]=key.split('-').map(Number), lastDay=new Date(year,month,0).getDate(), day=Math.min(Math.max(Number(card.dueDay)||1,1),lastDay); return `${key}-${String(day).padStart(2,'0')}`; };
const purchaseIsPaid = (card,item) => Boolean(item.status_pagamento||state.invoicePayments[`${invoiceMonthForPurchase(card,item)}_${card.id}`]);
const recordsForMonth = () => state.records.filter(item => String(item.data || '').slice(0,7) === monthKey());
const formatDate = value => value ? new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short'}).format(new Date(`${value}T12:00:00`)) : '-';
const money = value => new Intl.NumberFormat('pt-BR',{style:'currency',currency:state.profile.currency || 'BRL'}).format(Number(value)||0);
const incomeIsAvailable = item => String(item.data||'')<=todayIso() && ((item.autoMonth||item.scheduledIncome)?true:Boolean(item.status_pagamento));
const daysFromToday = value => Math.ceil((new Date(`${value}T12:00:00`)-new Date(`${todayIso()}T12:00:00`))/86400000);

function getClient() {
    if (!supabaseClient && window.supabase) supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return supabaseClient;
}

function normalizeState(payload = {}) {
    const base = createDefaultState();
    const legacyProfile = payload.usuario || payload.profile || {};
    const legacyGoals = payload.metas || payload.goals || {};
    const migratedGoals=Array.isArray(payload.goalList)?payload.goalList:(Number(legacyGoals.target ?? legacyGoals.economiaMensal)>0?[{id:'legacy_goal',name:legacyGoals.name||'Reserva financeira',targetAmount:Number(legacyGoals.target ?? legacyGoals.economiaMensal)||0,currentAmount:Number(legacyGoals.saved)||0,deadline:'',category:'Outros',priority:'medium',icon:'target',notes:'',contributionType:'none',contributionAmount:0,status:'active',createdAt:new Date().toISOString()}]:[]);
    return {
        ...base,
        records: Array.isArray(payload.records) ? payload.records : Array.isArray(payload.despesas) ? payload.despesas : [],
        recurringTransactions: Array.isArray(payload.recurringTransactions) ? payload.recurringTransactions : [],
        goalList: migratedGoals,
        goalMovements: Array.isArray(payload.goalMovements) ? payload.goalMovements : [],
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

function payload() { return { version:3, updatedAt:new Date().toISOString(), records:state.records, recurringTransactions:state.recurringTransactions, goalList:state.goalList, goalMovements:state.goalMovements, cards:state.cards, goals:state.goals, invoicePayments:state.invoicePayments, profile:state.profile }; }
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
    ensureRecurringCharges();
    ensureGoalContributions();
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
    if (data.session?.user && !recoveryMode) await enterApp(data.session.user); else if(!recoveryMode) showAuth();
}

function hideScreen(id) { $(id).classList.add('hidden'); $(id).classList.remove('flex'); }
function showAuth() { hideScreen('recovery-screen'); $('auth-screen').classList.remove('hidden'); $('auth-screen').classList.add('flex'); $('app-shell').classList.add('hidden'); renderIcons(); }
function showRecovery() { recoveryMode=true; hideScreen('auth-screen'); $('app-shell').classList.add('hidden'); $('recovery-screen').classList.remove('hidden'); $('recovery-screen').classList.add('flex'); $('recovery-password').focus(); renderIcons(); }
async function enterApp(authUser) { user = authUser; hideScreen('auth-screen'); hideScreen('recovery-screen'); $('app-shell').classList.remove('hidden'); await loadState(); if(!appInitialized){setupApp();appInitialized=true;}else{renderNavigation();populateForms();navigate('home');} }

function setupRecoveryFlow() {
    const client=getClient();
    if(!client)return;
    client.auth.onAuthStateChange((event,session)=>{
        if(event==='PASSWORD_RECOVERY') { user=session?.user||null; showRecovery(); }
    });
    $('recovery-form').onsubmit=async event=>{
        event.preventDefault();
        const password=$('recovery-password').value, confirmation=$('recovery-password-confirm').value, button=$('recovery-submit');
        if(password!==confirmation){$('recovery-status').textContent='As senhas não coincidem.';return;}
        button.disabled=true;button.textContent='Salvando...';$('recovery-status').textContent='';
        const {data,error}=await client.auth.updateUser({password});
        button.disabled=false;button.textContent='Salvar nova senha';
        if(error){$('recovery-status').textContent=error.message;return;}
        recoveryMode=false;$('recovery-form').reset();
        await enterApp(data.user||user);
        showToast('Senha alterada com sucesso.');navigate('home');
    };
}

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
    if(view!=='new') resetCardForm();
    currentView=view; document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',el.id===`view-${view}`));
    document.querySelectorAll('.nav-link').forEach(el=>{ const active=el.dataset.view===view; el.classList.toggle('bg-ink',active); el.classList.toggle('text-white',active); el.classList.toggle('text-gray-500',!active); });
    $('mobile-menu').classList.add('hidden');
    if(view==='home') renderHome(); if(view==='cards') renderCards(); if(view==='goals') renderGoals(); if(view==='settings') fillSettings();
    renderIcons(); window.scrollTo({top:0,behavior:'smooth'});
}

function bindStaticEvents() {
    $('mobile-menu-button').onclick=()=>$('mobile-menu').classList.toggle('hidden');
    $('theme-toggle').onclick=toggleTheme; $('mobile-theme-toggle').onclick=toggleTheme;
    $('logout-button').onclick=async()=>{ await syncCloud(); await getClient().auth.signOut(); user=null; showAuth(); };
    $('expense-method').onchange=toggleExpenseMethod;
    $('card-purchase-type').onchange=toggleCardPurchaseType;
    $('recurring-duration').onchange=toggleRecurringDuration;
    $('expense-value').oninput=updateInstallmentPreview;
    $('expense-installments').oninput=updateInstallmentPreview;
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
function setRecordTab(tab) { if(tab==='card')resetCardForm();currentRecordTab=tab;document.querySelectorAll('.record-form').forEach(form=>form.classList.toggle('hidden',form.id!==`${tab}-form`));renderRecordTabs(); }
function resetCardForm() { const form=$('card-form');if(!form)return;form.reset();$('card-edit-id').value='';const button=form.querySelector('button');if(button)button.textContent='Salvar cartão'; }
function toggleExpenseMethod() { const card=$('expense-method').value==='cartao'; $('expense-card-fields').classList.toggle('hidden',!card); $('expense-cycle-wrap').classList.toggle('hidden',card); $('expense-repeat-wrap').classList.toggle('hidden',card); }
function toggleCardPurchaseType() { const type=$('card-purchase-type').value; $('card-installment-fields').classList.toggle('hidden',type!=='installment');$('card-recurring-fields').classList.toggle('hidden',type!=='recurring');updateInstallmentPreview(); }
function toggleRecurringDuration() { const duration=$('recurring-duration').value;$('recurring-count-wrap').classList.toggle('hidden',duration!=='count');$('recurring-until-wrap').classList.toggle('hidden',duration!=='until'); }
function updateInstallmentPreview() { const total=Number($('expense-value').value)||0,count=Math.max(1,Number($('expense-installments').value)||1);$('installment-preview').textContent=money(total/count); }
function updateCardOptions() { $('expense-card').innerHTML=state.cards.length?state.cards.map(card=>`<option value="${card.id}">${escapeHtml(card.name)}</option>`).join(''):'<option value="">Cadastre um cartão</option>'; }

function ensureAutomaticIncome() {
    const key=monthKey(), profile=state.profile;
    if(!profile.salary) return;
    const dateFor=day=>`${key}-${String(Math.min(Number(day)||1,new Date(currentDate.getFullYear(),currentDate.getMonth()+1,0).getDate())).padStart(2,'0')}`;
    const addIfMissing=(kind,record)=>{
        const id=`auto_${key}_${kind}`;
        if(state.records.some(item=>item.id===id || (item.autoMonth===key && item.autoType===kind))) return;
        const data=record.data;
        state.records.push({id,autoMonth:key,autoType:kind,...record,status_pagamento:data<=todayIso()});
    };
    if(profile.advanceDay && profile.advanceDay!==profile.payday) {
        addIfMissing('advance',{tipo:'receita',descricao:'Adiantamento',valor:profile.salary*.4,data:dateFor(profile.advanceDay),categoria:'Salário'});
        addIfMissing('salary',{tipo:'receita',descricao:'Pagamento',valor:profile.salary*.6,data:dateFor(profile.payday),categoria:'Salário'});
    } else addIfMissing('salary',{tipo:'receita',descricao:'Salário',valor:profile.salary,data:dateFor(profile.payday),categoria:'Salário'});
}

function ensureRecurringCharges(targetMonth=monthKey()) {
    state.recurringTransactions.filter(item=>item.status==='active').forEach(recurring=>{
        let date=recurring.startDate, sequence=1, guard=0;
        while(date && date.slice(0,7)<=targetMonth && guard++<1000) {
            const beyondCount=recurring.repeatCount&&sequence>recurring.repeatCount, beyondEnd=recurring.endDate&&date>recurring.endDate;
            if(beyondCount||beyondEnd)break;
            const exists=state.records.some(item=>item.recurring_transaction_id===recurring.id&&item.sequence_number===sequence);
            const skipped=(recurring.skippedSequences||[]).includes(sequence);
            if(!exists&&!skipped)state.records.push({id:uid('recurring'),tipo:'cartao',cardId:recurring.cardId,cartao_nome:recurring.cardName,descricao:recurring.description,valor_total:recurring.amount,valor_parcela:recurring.amount,quantidade_parcelas:1,parcela_atual:1,data,categoria:recurring.category,status_pagamento:false,recurring_transaction_id:recurring.id,recurring_frequency:recurring.frequency,sequence_number:sequence,total_repetitions:recurring.repeatCount||null});
            date=nextRecurringDate(date,recurring.frequency);sequence++;
        }
        recurring.generatedCount=Math.max(Number(recurring.generatedCount)||0,sequence-1);
        if((recurring.repeatCount&&sequence>recurring.repeatCount)||(recurring.endDate&&date>recurring.endDate))recurring.status='finished';
    });
}

function effectiveGoalStatus(goal) { if(['paused','cancelled'].includes(goal.status))return goal.status;if(Number(goal.currentAmount)>=Number(goal.targetAmount)&&Number(goal.targetAmount)>0)return 'completed';if(goal.deadline&&goal.deadline<todayIso())return 'overdue';return 'active'; }
function syncGoalSummary() { const goal=state.goalList.find(item=>['active','overdue'].includes(effectiveGoalStatus(item)))||state.goalList[0];state.goals={...state.goals,name:goal?.name||'Nenhuma meta',target:Number(goal?.targetAmount)||0,saved:Number(goal?.currentAmount)||0}; }
function ensureGoalContributions() {
    const key=monthKey(), today=todayIso();
    state.goalList.forEach(goal=>{
        if(effectiveGoalStatus(goal)!=='active'||!goal.contributionAmount||goal.contributionType==='none')return;
        let sourceDate='';
        if(goal.contributionType==='payment')sourceDate=state.records.find(item=>item.id===`auto_${key}_salary`&&item.status_pagamento)?.data||'';
        if(goal.contributionType==='advance')sourceDate=state.records.find(item=>item.id===`auto_${key}_advance`&&item.status_pagamento)?.data||'';
        if(goal.contributionType==='monthly'){const day=Math.min(state.profile.payday||1,new Date(currentDate.getFullYear(),currentDate.getMonth()+1,0).getDate());sourceDate=`${key}-${String(day).padStart(2,'0')}`;}
        const movementId=`goal_auto_${goal.id}_${key}_${goal.contributionType}`;
        if(!sourceDate||sourceDate>today||sourceDate<String(goal.createdAt||'').slice(0,10)||state.goalMovements.some(item=>item.id===movementId))return;
        const amount=Math.min(Number(goal.contributionAmount),Math.max(Number(goal.targetAmount)-Number(goal.currentAmount),0));if(!amount)return;
        goal.currentAmount=Number(goal.currentAmount)+amount;state.goalMovements.push({id:movementId,goalId:goal.id,type:'automatic_contribution',amount,date:sourceDate,description:'Contribuição programada',createdAt:new Date().toISOString()});
        state.records.push({id:`transaction_${movementId}`,tipo:'padrao',descricao:`Transferência para meta: ${goal.name}`,valor:amount,data:sourceDate,categoria:'Metas',ciclo:goal.contributionType==='advance'?'adiantamento':'pagamento',status_pagamento:true,paymentDate:sourceDate,goal_id:goal.id,goal_movement_id:movementId});
    });syncGoalSummary();
}

function renderGoals() {
    const priorities={low:'Baixa',medium:'Média',high:'Alta'},statuses={active:'Em andamento',completed:'Concluída',paused:'Pausada',cancelled:'Cancelada',overdue:'Atrasada'};
    $('view-goals').innerHTML=`<div class="mb-6 flex flex-wrap items-end justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-widest text-sage-700">Planejamento</p><h1 class="mt-1 text-2xl font-bold">Metas financeiras</h1><p class="mt-1 text-sm text-gray-500">Crie objetivos e preserve o histórico de cada valor movimentado.</p></div></div><div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]"><div class="grid content-start gap-4 md:grid-cols-2">${state.goalList.length?state.goalList.map(goal=>renderGoalCard(goal,priorities,statuses)).join(''):empty('Nenhuma meta cadastrada.')}</div>${renderGoalForm()}</div>`;
    $('goal-form').onsubmit=saveGoal;document.querySelectorAll('[data-goal-action]').forEach(button=>button.onclick=()=>handleGoalAction(button.dataset.goalAction,button.dataset.id));renderIcons();
}
function renderGoalCard(goal,priorities,statuses) { const current=Number(goal.currentAmount)||0,target=Number(goal.targetAmount)||0,pct=target?Math.min(current/target*100,100):0,status=effectiveGoalStatus(goal),remaining=Math.max(target-current,0),months=goal.deadline?Math.max(1,(new Date(`${goal.deadline}T12:00:00`).getFullYear()-new Date().getFullYear())*12+new Date(`${goal.deadline}T12:00:00`).getMonth()-new Date().getMonth()):0,monthly=months?remaining/months:0,movements=state.goalMovements.filter(item=>item.goalId===goal.id).sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,3);return `<article class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><div class="flex items-start justify-between gap-3"><div><span class="text-xs text-gray-400">${escapeHtml(goal.category||'Outros')} · Prioridade ${priorities[goal.priority]||'Média'}</span><h2 class="mt-1 font-bold">${escapeHtml(goal.name)}</h2></div><span class="rounded-full bg-sage-50 px-2.5 py-1 text-[10px] font-bold text-sage-700">${statuses[status]}</span></div><div class="mt-5 h-2.5 overflow-hidden rounded-full bg-gray-100"><div class="h-full rounded-full bg-sage-500" style="width:${pct}%"></div></div><div class="mt-3 flex justify-between text-sm"><strong>${money(current)} / ${money(target)}</strong><span class="text-gray-500">${pct.toFixed(0)}%</span></div><p class="mt-2 text-xs text-gray-400">Faltam ${money(remaining)}${goal.deadline?` · Prazo ${formatDate(goal.deadline)}`:''}</p>${monthly&&status==='active'?`<p class="mt-2 rounded-lg bg-sage-50 p-2 text-xs text-sage-700">Para cumprir o prazo, reserve aproximadamente ${money(monthly)} por mês.</p>`:''}<div class="mt-4 flex flex-wrap gap-2"><button data-goal-action="deposit" data-id="${goal.id}" class="rounded-lg bg-ink px-3 py-2 text-xs font-semibold text-white">Adicionar valor</button><button data-goal-action="withdraw" data-id="${goal.id}" class="rounded-lg bg-gray-100 px-3 py-2 text-xs font-semibold text-gray-600">Retirar</button><button data-goal-action="edit" data-id="${goal.id}" class="rounded-lg bg-gray-100 px-3 py-2 text-xs font-semibold text-gray-600">Editar</button><button data-goal-action="${status==='paused'?'resume':'pause'}" data-id="${goal.id}" class="rounded-lg px-3 py-2 text-xs font-semibold text-amber-600">${status==='paused'?'Reativar':'Pausar'}</button><button data-goal-action="delete" data-id="${goal.id}" class="rounded-lg px-3 py-2 text-xs font-semibold text-red-500">Excluir</button></div>${movements.length?`<div class="mt-4 border-t border-gray-100 pt-3">${movements.map(item=>`<div class="flex justify-between py-1 text-xs"><span class="text-gray-500">${formatDate(item.date)} · ${escapeHtml(item.description||item.type)}</span><strong class="${item.type==='withdrawal'?'text-red-500':'text-emerald-600'}">${item.type==='withdrawal'?'-':'+'}${money(item.amount)}</strong></div>`).join('')}</div>`:''}</article>`; }
function renderGoalForm() { return `<form id="goal-form" class="h-fit space-y-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><input id="goal-edit-id" type="hidden"><div><h2 id="goal-form-title" class="font-bold">Adicionar meta</h2><p class="mt-1 text-xs text-gray-400">O valor guardado é alterado pelas movimentações.</p></div><label class="block text-sm font-medium">Nome<input id="goal-name" required class="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3"></label><div class="grid gap-3 sm:grid-cols-2"><label class="text-sm font-medium">Valor desejado<input id="goal-target" type="number" min="0.01" step="0.01" required class="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3"></label><label class="text-sm font-medium">Data limite<input id="goal-deadline" type="date" class="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3"></label><label class="text-sm font-medium">Categoria<select id="goal-category" class="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-4 py-3"><option>Viagem</option><option>Reserva de emergência</option><option>Veículo</option><option>Casa</option><option>Curso</option><option>Eletrônico</option><option>Investimento</option><option>Outro</option></select></label><label class="text-sm font-medium">Prioridade<select id="goal-priority" class="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-4 py-3"><option value="low">Baixa</option><option value="medium" selected>Média</option><option value="high">Alta</option></select></label><label class="text-sm font-medium">Contribuição<select id="goal-contribution-type" class="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-4 py-3"><option value="none">Não</option><option value="monthly">Mensalmente</option><option value="payment">Em cada pagamento</option><option value="advance">Em cada adiantamento</option></select></label><label class="text-sm font-medium">Valor da contribuição<input id="goal-contribution-amount" type="number" min="0" step="0.01" class="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3"></label></div><label class="block text-sm font-medium">Observação<textarea id="goal-notes" rows="3" class="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3"></textarea></label><button class="w-full rounded-xl bg-ink px-5 py-3 font-semibold text-white">Salvar meta</button></form>`; }
function saveGoal(event) { event.preventDefault();const id=$('goal-edit-id').value||uid('goal'),existing=state.goalList.find(item=>item.id===id),goal={id,name:$('goal-name').value.trim(),targetAmount:Number($('goal-target').value),currentAmount:Number(existing?.currentAmount)||0,deadline:$('goal-deadline').value,category:$('goal-category').value,priority:$('goal-priority').value,icon:existing?.icon||'target',notes:$('goal-notes').value.trim(),contributionType:$('goal-contribution-type').value,contributionAmount:Number($('goal-contribution-amount').value)||0,status:existing?.status||'active',createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};const index=state.goalList.findIndex(item=>item.id===id);if(index>=0)state.goalList[index]=goal;else state.goalList.push(goal);syncGoalSummary();saveState();showToast(index>=0?'Meta atualizada.':'Meta criada.');renderGoals(); }
function handleGoalAction(action,id) { const goal=state.goalList.find(item=>item.id===id);if(!goal)return;if(action==='deposit'||action==='withdraw')return moveGoal(goal,action);if(action==='edit'){renderGoals();$('goal-edit-id').value=goal.id;$('goal-form-title').textContent='Editar meta';$('goal-name').value=goal.name;$('goal-target').value=goal.targetAmount;$('goal-deadline').value=goal.deadline||'';$('goal-category').value=goal.category||'Outro';$('goal-priority').value=goal.priority||'medium';$('goal-contribution-type').value=goal.contributionType||'none';$('goal-contribution-amount').value=goal.contributionAmount||'';$('goal-notes').value=goal.notes||'';$('goal-name').focus();return;}if(action==='pause'||action==='resume'){goal.status=action==='pause'?'paused':'active';saveState();showToast(action==='pause'?'Meta pausada.':'Meta reativada.');renderGoals();return;}if(action==='delete')deleteGoal(goal); }
function moveGoal(goal,action) { const withdrawing=action==='withdraw',raw=window.prompt(withdrawing?'Valor que deseja retirar:':'Valor que deseja adicionar:','0');if(raw===null)return;const amount=Number(String(raw).replace(',','.'));if(!amount||amount<=0)return showToast('Informe um valor válido.');if(withdrawing&&amount>Number(goal.currentAmount))return showToast('O valor supera o total guardado.');const movementId=uid('goal_movement'),date=todayIso();goal.currentAmount=Number(goal.currentAmount)+(withdrawing?-amount:amount);state.goalMovements.push({id:movementId,goalId:goal.id,type:withdrawing?'withdrawal':'deposit',amount,date,description:withdrawing?'Retirada da meta':'Depósito na meta',createdAt:new Date().toISOString()});if(withdrawing){state.records.push({id:uid('income'),tipo:'receita',descricao:`Resgate da meta: ${goal.name}`,valor:amount,data,categoria:'Metas',status_pagamento:true,goal_id:goal.id,goal_movement_id:movementId});}else if(window.confirm('Registrar este valor como saída no planejamento?')){state.records.push({id:uid('expense'),tipo:'padrao',descricao:`Transferência para meta: ${goal.name}`,valor:amount,data,categoria:'Metas',ciclo:'pagamento',status_pagamento:true,paymentDate:date,goal_id:goal.id,goal_movement_id:movementId});}syncGoalSummary();saveState();showToast(withdrawing?'Valor retirado da meta.':'Valor adicionado à meta.');renderGoals(); }
function deleteGoal(goal) { let choice='2';if(Number(goal.currentAmount)>0)choice=window.prompt(`Esta meta possui ${money(goal.currentAmount)} guardados.\n1 - Devolver ao saldo disponível\n2 - Excluir a meta e o histórico\n3 - Cancelar`,'1');if(choice==='3'||choice===null)return;if(!['1','2'].includes(choice))return showToast('Opção inválida.');if(choice==='1'&&Number(goal.currentAmount)>0)state.records.push({id:uid('income'),tipo:'receita',descricao:`Resgate da meta excluída: ${goal.name}`,valor:Number(goal.currentAmount),data:todayIso(),categoria:'Metas',status_pagamento:true,goal_id:goal.id});if(choice==='2')state.records=state.records.filter(item=>item.goal_id!==goal.id);state.goalList=state.goalList.filter(item=>item.id!==goal.id);state.goalMovements=state.goalMovements.filter(item=>item.goalId!==goal.id);syncGoalSummary();saveState();showToast('Meta excluída.');renderGoals(); }

function invoiceItems() {
    return state.cards.map(card=>{ const invoiceMonth=monthKey(), purchases=state.records.filter(item=>cardMatchesPurchase(card,item)&&invoiceMonthForPurchase(card,item)===invoiceMonth); const total=purchases.reduce((sum,item)=>sum+valueOf(item),0); const key=`${invoiceMonth}_${card.id}`; const paid=Boolean(state.invoicePayments[key]) || (purchases.length>0 && purchases.every(item=>item.status_pagamento)); return {id:`invoice_${key}`,invoiceKey:key,card,purchases,total,status_pagamento:paid,data:invoiceDueDate(card,invoiceMonth),descricao:`Fatura ${card.name}`,ciclo:card.invoiceCycle || state.profile.invoiceCycle || 'pagamento'}; }).filter(item=>item.total>0);
}

function renderHome() {
    syncGoalSummary();
    const monthly=recordsForMonth(), incomes=monthly.filter(i=>i.tipo==='receita'), standard=monthly.filter(i=>i.tipo!=='receita'&&i.tipo!=='cartao'), invoices=invoiceItems();
    const receivedIncomes=incomes.filter(incomeIsAvailable);
    const paidStandard=standard.filter(i=>i.status_pagamento), pendingStandard=standard.filter(i=>!i.status_pagamento), paidInvoices=invoices.filter(i=>i.status_pagamento), pendingInvoices=invoices.filter(i=>!i.status_pagamento);
    const revenue=receivedIncomes.reduce((s,i)=>s+valueOf(i),0), projectedRevenue=incomes.reduce((s,i)=>s+valueOf(i),0), paid=paidStandard.reduce((s,i)=>s+valueOf(i),0)+paidInvoices.reduce((s,i)=>s+i.total,0), pending=pendingStandard.reduce((s,i)=>s+valueOf(i),0)+pendingInvoices.reduce((s,i)=>s+i.total,0);
    const available=revenue-paid;
    const cycleItems=cycle=>[...pendingStandard.filter(i=>(i.ciclo||'pagamento')===cycle),...pendingInvoices.filter(i=>i.ciclo===cycle)];
    const history=[...paidStandard,...paidInvoices].sort((a,b)=>String(b.paymentDate||b.data).localeCompare(String(a.paymentDate||a.data)));
    const incomeHistory=[...incomes].sort((a,b)=>String(b.data).localeCompare(String(a.data))), scheduledIncomes=incomes.filter(item=>!incomeIsAvailable(item));
    const goalPercent=state.goals.target?Math.min(state.goals.saved/state.goals.target*100,100):0;
    $('view-home').innerHTML=`
        <div class="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p class="text-xs font-bold uppercase tracking-widest text-sage-700">Visão geral</p><h1 class="mt-1 text-2xl font-bold">Olá, ${escapeHtml(state.profile.name.split(' ')[0])}</h1></div><p class="text-xs text-gray-400">Pagamento, edição e exclusão pedem dois cliques ou toques.</p></div>
        <section class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-7"><div class="flex items-center justify-between"><button data-month-nav="-1" class="mobile-action rounded-lg p-2 hover:bg-gray-100"><i data-lucide="chevron-left"></i></button><strong class="px-2 text-center text-sm sm:text-base">${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}</strong><button data-month-nav="1" class="mobile-action rounded-lg p-2 hover:bg-gray-100"><i data-lucide="chevron-right"></i></button></div><div class="mt-5 grid grid-cols-2 gap-3 sm:mt-6 sm:gap-4 xl:grid-cols-4">${summaryCard('Saldo disponível',money(available),'wallet','sage')}${summaryCard('Receitas recebidas',money(revenue),'trending-up','blue')}${summaryCard('Despesas pendentes',money(pending),'clock-3','amber')}${summaryCard('Saldo projetado',money(projectedRevenue-paid-pending),'chart-no-axes-combined',projectedRevenue-paid-pending>=0?'gray':'red')}</div></section>${renderDueAlerts([...pendingStandard,...pendingInvoices])}
        <div class="mt-6 grid gap-6 xl:grid-cols-2">${renderCycle('Ciclo de Pagamento',cycleItems('pagamento'),'Pagamento')}${renderCycle('Ciclo de Adiantamento',cycleItems('adiantamento'),'Adiantamento')}</div>
        <div class="mt-6 grid gap-6 xl:grid-cols-3"><section class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><div class="flex items-center justify-between"><div><p class="text-xs text-gray-400">Meta</p><h2 class="mt-1 font-bold">${escapeHtml(state.goals.name)}</h2></div><span class="text-sm font-bold text-sage-700">${goalPercent.toFixed(0)}%</span></div><div class="mt-5 h-2.5 overflow-hidden rounded-full bg-gray-100"><div class="h-full rounded-full bg-sage-500" style="width:${goalPercent}%"></div></div><div class="mt-3 flex justify-between text-xs text-gray-500"><span>${money(state.goals.saved)}</span><span>${money(state.goals.target)}</span></div></section><section class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><div class="flex items-center justify-between"><h2 class="font-bold">Histórico de despesas</h2><span class="text-xs text-gray-400">${history.length} itens</span></div><div class="mt-3 max-h-72 divide-y divide-gray-100 overflow-y-auto scrollbar">${history.length?history.map(renderHistory).join(''):empty('Nenhum pagamento neste mês.')}</div></section><section class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><div class="flex items-start justify-between gap-3"><div><h2 class="font-bold">Histórico de receitas</h2>${scheduledIncomes.length?`<p class="mt-1 text-[11px] text-amber-600">${scheduledIncomes.length} receita(s) agendada(s) ainda não disponível(is)</p>`:''}</div><span class="text-xs font-semibold text-emerald-600" title="Total já disponível">${money(revenue)}</span></div><div class="mt-3 max-h-72 divide-y divide-gray-100 overflow-y-auto scrollbar">${incomeHistory.length?incomeHistory.map(renderIncomeHistory).join(''):empty('Nenhuma receita neste mês.')}</div></section></div>`;
    document.querySelectorAll('[data-month-nav]').forEach(button=>button.onclick=()=>changeMonth(Number(button.dataset.monthNav)));
    bindConfirmButtons(); renderIcons();
}

function summaryCard(label,value,icon,tone) { const colors={sage:'from-emerald-100 to-sage-50 text-sage-700 ring-emerald-100',blue:'from-sky-100 to-slate-50 text-slate-700 ring-sky-100',amber:'from-amber-100 to-orange-50 text-amber-700 ring-amber-100',gray:'from-violet-100 to-slate-50 text-slate-700 ring-violet-100',red:'from-rose-100 to-red-50 text-red-600 ring-rose-100'}; return `<div class="summary-card group relative min-w-0 overflow-hidden rounded-xl border border-gray-100 bg-gradient-to-br from-white to-gray-50/70 p-3 transition hover:-translate-y-0.5 hover:shadow-md sm:rounded-2xl sm:p-4"><div class="absolute -right-5 -top-5 h-20 w-20 rounded-full bg-gray-100/60 blur-xl"></div><div class="relative flex items-start justify-between"><div class="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br ${colors[tone]} shadow-sm ring-1 sm:h-11 sm:w-11 sm:rounded-xl"><i data-lucide="${icon}" class="h-4 w-4 sm:h-5 sm:w-5" stroke-width="1.8"></i></div><i data-lucide="sparkles" class="hidden h-4 w-4 text-gray-200 transition group-hover:text-sage-400 sm:block"></i></div><p class="summary-label relative mt-3 text-[11px] font-medium leading-tight text-gray-400 sm:mt-4 sm:text-xs">${label}</p><strong class="summary-value relative mt-1 block truncate text-lg tracking-tight sm:text-xl" title="${value}">${value}</strong></div>`; }
function renderDueAlerts(items) { const alerts=items.map(item=>({item,days:daysFromToday(item.data)})).filter(entry=>entry.days<=5).sort((a,b)=>a.days-b.days);if(!alerts.length)return '';return `<section class="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4"><div class="flex items-start gap-3"><i data-lucide="bell-ring" class="mt-0.5 h-5 w-5 shrink-0 text-amber-700"></i><div class="min-w-0 flex-1"><h2 class="text-sm font-bold text-amber-800">Alertas de vencimento</h2><div class="mt-2 space-y-1.5">${alerts.map(({item,days})=>`<div class="flex flex-wrap justify-between gap-2 text-xs"><span class="truncate text-amber-800">${escapeHtml(item.descricao)}</span><strong class="${days<0?'text-red-600':'text-amber-700'}">${days<0?`Vencida há ${Math.abs(days)} dia(s)`:days===0?'Vence hoje':`Vence em ${days} dia(s)`} · ${money(item.invoiceKey?item.total:valueOf(item))}</strong></div>`).join('')}</div></div></div></section>`; }
function renderCycle(title,items,badge) { const total=items.reduce((sum,item)=>sum+(item.invoiceKey?item.total:valueOf(item)),0); return `<section class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><div class="flex items-start justify-between gap-3"><div><h2 class="font-bold">${title}</h2><p class="mt-1 text-xs text-gray-400">${items.length} conta(s) pendente(s)</p></div><div class="text-right"><span class="block text-[10px] uppercase tracking-wide text-gray-400">Total do ciclo</span><strong class="mt-1 block text-lg">${money(total)}</strong></div></div><div class="mt-3 divide-y divide-gray-100">${items.length?items.map(item=>renderPending(item,badge)).join(''):empty('Nenhuma conta pendente.')}</div></section>`; }
function renderPending(item,badge) { const invoice=Boolean(item.invoiceKey), value=invoice?item.total:valueOf(item); return `<div class="group flex items-center gap-3 py-3.5"><div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl ${invoice?'bg-slate-100 text-slate-600':'bg-amber-50 text-amber-700'}"><i data-lucide="${invoice?'credit-card':'receipt-text'}" class="h-4 w-4"></i></div><div class="min-w-0 flex-1"><strong class="block truncate text-sm">${escapeHtml(item.descricao)}</strong><span class="text-[11px] text-gray-400">${formatDate(item.data)} · ${badge}</span></div><strong class="text-sm">${money(value)}</strong><div class="flex gap-1"><button data-confirm-action="pay" data-id="${item.id}" class="rounded-lg bg-sage-50 p-2 text-sage-700" title="Pagar"><i data-lucide="check" class="h-4 w-4"></i></button><button data-confirm-action="${invoice?'edit-invoice':'edit-record'}" data-id="${item.id}" class="rounded-lg bg-gray-100 p-2 text-gray-500" title="Editar"><i data-lucide="pencil" class="h-4 w-4"></i></button>${!invoice?`<button data-double-action="delete-record" data-id="${item.id}" class="rounded-lg p-2 text-gray-300 hover:text-red-500" title="Excluir"><i data-lucide="trash-2" class="h-4 w-4"></i></button>`:''}</div></div>`; }
function renderHistory(item) { const value=item.invoiceKey?item.total:valueOf(item), editAction=item.invoiceKey?'edit-invoice':'edit-record'; return `<div class="flex items-center gap-3 py-3"><div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-100 to-sage-50 text-sage-700 ring-1 ring-emerald-100"><i data-lucide="badge-check" class="h-4 w-4"></i></div><div class="min-w-0 flex-1"><strong class="block truncate text-sm">${escapeHtml(item.descricao)}</strong><span class="text-[11px] text-gray-400">Pago em ${formatDate(item.paymentDate||item.data)}</span></div><span class="text-sm font-semibold text-gray-600">${money(value)}</span><div class="flex gap-1"><button data-confirm-action="unpay" data-id="${item.id}" class="rounded-lg bg-amber-50 p-2 text-amber-700" title="Desfazer pagamento"><i data-lucide="undo-2" class="h-4 w-4"></i></button><button data-confirm-action="${editAction}" data-id="${item.id}" class="rounded-lg bg-gray-100 p-2 text-gray-500 hover:text-sage-700" title="Editar"><i data-lucide="square-pen" class="h-4 w-4"></i></button>${!item.invoiceKey?`<button data-double-action="delete-record" data-id="${item.id}" class="rounded-lg p-2 text-gray-300 hover:bg-red-50 hover:text-red-500" title="Excluir"><i data-lucide="trash-2" class="h-4 w-4"></i></button>`:''}</div></div>`; }
function renderIncomeHistory(item) { const available=incomeIsAvailable(item),future=String(item.data||'')>todayIso();return `<div class="flex items-center gap-3 py-3 ${available?'':'rounded-xl bg-amber-50/70 px-2'}"><div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl ${available?'bg-gradient-to-br from-emerald-100 to-green-50 text-emerald-600 ring-1 ring-emerald-100':'bg-amber-100 text-amber-700 ring-1 ring-amber-200'}"><i data-lucide="${available?'circle-dollar-sign':'clock-3'}" class="h-4 w-4"></i></div><div class="min-w-0 flex-1"><strong class="block truncate text-sm">${escapeHtml(item.descricao)}</strong><span class="text-[11px] ${available?'text-gray-400':'font-medium text-amber-700'}">${available?`${formatDate(item.data)} · ${escapeHtml(item.categoria||'Receita')}`:future?`Agendada · Disponível em ${formatDate(item.data)}`:'Aguardando disponibilidade'}</span></div><div class="text-right"><strong class="block text-sm ${available?'text-emerald-600':'text-amber-700'}">${available?'+':'Previsto '}${money(valueOf(item))}</strong>${!available?'<span class="text-[9px] font-bold uppercase tracking-wide text-amber-600">Não compõe o saldo</span>':''}</div>${!item.autoMonth?`<div class="flex gap-1"><button data-confirm-action="edit-record" data-id="${item.id}" class="rounded-lg bg-gray-100 p-2 text-gray-500 hover:text-sage-700" title="Editar"><i data-lucide="square-pen" class="h-4 w-4"></i></button><button data-double-action="delete-record" data-id="${item.id}" class="rounded-lg p-2 text-gray-300 hover:bg-red-50 hover:text-red-500" title="Excluir"><i data-lucide="trash-2" class="h-4 w-4"></i></button></div>`:''}</div>`; }
const empty = text => `<p class="py-8 text-center text-sm text-gray-400">${text}</p>`;

function renderCards() {
    const invoices=invoiceItems();
    $('view-cards').innerHTML=`<div class="mb-6 flex flex-col justify-between gap-4 xl:flex-row xl:items-end"><div><p class="text-xs font-bold uppercase tracking-widest text-sage-700">Crédito</p><h1 class="mt-1 text-2xl font-bold">Cartões</h1><p class="mt-1 text-sm text-gray-500">Compras e faturas do mês selecionado</p></div><div class="flex flex-col gap-3 sm:flex-row sm:items-center"><div class="flex min-h-12 items-center justify-between rounded-xl border border-gray-200 bg-white p-1 shadow-sm sm:min-w-56"><button data-card-month-nav="-1" class="mobile-action rounded-lg p-2 text-gray-500 hover:bg-gray-100" aria-label="Mês anterior"><i data-lucide="chevron-left" class="h-5 w-5"></i></button><strong class="px-3 text-center text-sm">${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}</strong><button data-card-month-nav="1" class="mobile-action rounded-lg p-2 text-gray-500 hover:bg-gray-100" aria-label="Próximo mês"><i data-lucide="chevron-right" class="h-5 w-5"></i></button></div><button id="add-card-purchase" class="min-h-12 rounded-xl bg-ink px-5 py-3 text-sm font-semibold text-white">Adicionar compra ou cartão</button></div></div>${renderSubscriptions()}<div class="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">${state.cards.length?state.cards.map(card=>renderCardWidget(card,invoices.find(i=>String(i.card.id)===String(card.id)))).join(''):empty('Nenhum cartão cadastrado.')}</div>`;
    document.querySelectorAll('[data-card-month-nav]').forEach(button=>button.onclick=()=>changeMonth(Number(button.dataset.cardMonthNav)));
    $('add-card-purchase').onclick=()=>{navigate('new');setRecordTab(state.cards.length?'expense':'card');if(state.cards.length){$('expense-method').value='cartao';toggleExpenseMethod();}};
    document.querySelectorAll('[data-edit-card]').forEach(button=>button.onclick=()=>editCard(button.dataset.editCard)); bindConfirmButtons(); renderIcons();
    document.querySelectorAll('[data-subscription-status]').forEach(button=>button.onclick=()=>setSubscriptionStatus(button.dataset.id,button.dataset.subscriptionStatus));
}
function monthlyRecurringCost(item) { const factor={weekly:52/12,biweekly:26/12,monthly:1,yearly:1/12}[item.frequency]||1;return item.amount*factor; }
function renderSubscriptions() { const items=state.recurringTransactions.filter(item=>item.status!=='cancelled'&&item.status!=='finished'),active=items.filter(item=>item.status==='active'),total=active.reduce((sum,item)=>sum+monthlyRecurringCost(item),0);return `<section class="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><div class="flex flex-wrap items-end justify-between gap-3"><div><p class="text-xs text-gray-400">Assinaturas ativas</p><strong class="mt-1 block text-xl">${active.length}</strong></div><div class="text-right"><p class="text-xs text-gray-400">Custo mensal estimado</p><strong class="mt-1 block text-xl text-sage-700">${money(total)}</strong></div></div><div class="mt-4 divide-y divide-gray-100">${items.length?items.map(item=>`<div class="flex flex-wrap items-center gap-3 py-3"><div class="min-w-0 flex-1"><strong class="block truncate text-sm">${escapeHtml(item.description)}</strong><span class="text-[11px] text-gray-400">${escapeHtml(item.cardName)} · ${item.status==='paused'?'Pausada':'Ativa'}</span></div><strong class="text-sm">${money(item.amount)}</strong><button data-subscription-status="${item.status==='paused'?'active':'paused'}" data-id="${item.id}" class="rounded-lg bg-gray-100 px-3 py-2 text-xs font-semibold text-gray-600">${item.status==='paused'?'Reativar':'Pausar'}</button><button data-confirm-action="cancel-subscription" data-id="${item.id}" class="rounded-lg px-3 py-2 text-xs font-semibold text-red-500">Cancelar</button></div>`).join(''):empty('Nenhuma assinatura cadastrada.')}</div></section>`; }
function setSubscriptionStatus(id,status) { const item=state.recurringTransactions.find(entry=>entry.id===id);if(!item)return;item.status=status;if(status==='active')ensureRecurringCharges();saveState();showToast(status==='active'?'Assinatura reativada.':'Assinatura pausada.');renderCards(); }
function cancelSubscription(id) { const item=state.recurringTransactions.find(entry=>entry.id===id);if(!item)return;item.status='cancelled';saveState();showToast('Assinatura cancelada. O histórico foi preservado.');renderCards(); }
function cardTheme(name='') { const key=name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); const themes=[[/nubank|\bnu\b/,'linear-gradient(135deg,#820ad1,#4c0677)','white'],[/inter/,'linear-gradient(135deg,#ff7a00,#d94f00)','white'],[/itau/,'linear-gradient(135deg,#ec7000,#003399)','white'],[/santander/,'linear-gradient(135deg,#ec0000,#9b0000)','white'],[/bradesco/,'linear-gradient(135deg,#cc092f,#8b001d)','white'],[/caixa/,'linear-gradient(135deg,#0066b3,#00a4e4)','white'],[/banco do brasil|\bbb\b/,'linear-gradient(135deg,#ffdf00,#1f4e9e)','#10264f'],[/c6/,'linear-gradient(135deg,#101010,#3b3b3b)','white'],[/picpay/,'linear-gradient(135deg,#21c25e,#087d38)','white'],[/mercado pago/,'linear-gradient(135deg,#00a9e0,#0072ce)','white'],[/xp/,'linear-gradient(135deg,#111,#b69335)','white']]; const found=themes.find(([regex])=>regex.test(key)); return found?{background:found[1],color:found[2]}:{background:'linear-gradient(135deg,#475569,#1e293b)',color:'white'}; }
function purchaseDetail(item) { if(item.recurring_transaction_id){const labels={monthly:'mensal',biweekly:'quinzenal',weekly:'semanal',yearly:'anual'},sequence=item.total_repetitions?`${item.sequence_number} de ${item.total_repetitions} cobranças`:'Sem data final';return `Assinatura ${labels[item.recurring_frequency]||'recorrente'} · ${sequence}`;}return `${item.parcela_atual||1}/${item.quantidade_parcelas||1} · ${item.categoria||'Outros'}`; }
function renderCardWidget(card,invoice) { const purchases=invoice?.purchases||[], total=invoice?.total||0, allPurchases=state.records.filter(item=>cardMatchesPurchase(card,item)), committed=allPurchases.filter(item=>!purchaseIsPaid(card,item)).reduce((sum,item)=>sum+valueOf(item),0), available=Math.max(card.limit-committed,0), pct=card.limit?Math.min(committed/card.limit*100,100):0,theme=cardTheme(card.name),cycle=card.invoiceCycle||state.profile.invoiceCycle||'pagamento'; return `<article class="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"><header class="p-5" style="background:${theme.background};color:${theme.color}"><div class="flex justify-between gap-3"><div><p class="text-xs opacity-70">Limite disponível após parcelas</p><strong class="mt-1 block text-xl">${money(available)}</strong><p class="mt-1 text-[10px] opacity-60">${money(committed)} comprometidos</p></div><div class="flex"><button data-edit-card="${card.id}" class="rounded-lg p-2 opacity-70 hover:bg-white/10 hover:opacity-100" title="Editar cartão"><i data-lucide="square-pen" class="h-4 w-4"></i></button><button data-double-action="delete-card" data-id="${card.id}" class="rounded-lg p-2 opacity-70 hover:bg-white/10 hover:opacity-100" title="Excluir cartão"><i data-lucide="trash-2" class="h-4 w-4"></i></button></div></div><div class="mt-7 flex items-end justify-between"><div><strong>${escapeHtml(card.name)}</strong><p class="mt-1 text-[10px] opacity-60">Fecha dia ${card.closingDay} · Vence dia ${card.dueDay}</p><span class="mt-2 inline-block rounded-full bg-white/15 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide">Ciclo de ${cycle}</span></div><i data-lucide="contactless" class="opacity-50"></i></div></header><div class="p-5"><div class="max-h-56 divide-y divide-gray-100 overflow-y-auto scrollbar">${purchases.length?purchases.map(item=>`<div class="flex items-center gap-3 py-3"><div class="min-w-0 flex-1"><strong class="block truncate text-sm">${escapeHtml(item.descricao)}</strong><span class="text-[11px] text-gray-400">${escapeHtml(purchaseDetail(item))}</span></div><span class="text-sm font-semibold">${money(valueOf(item))}</span><div class="flex gap-1"><button data-confirm-action="edit-record" data-id="${item.id}" class="rounded-lg bg-gray-100 p-2 text-gray-500 hover:text-sage-700" title="Editar compra"><i data-lucide="square-pen" class="h-4 w-4"></i></button><button data-double-action="delete-record" data-id="${item.id}" class="rounded-lg p-2 text-gray-300 hover:bg-red-50 hover:text-red-500" title="Excluir compra"><i data-lucide="trash-2" class="h-4 w-4"></i></button></div></div>`).join(''):empty('Sem compras neste mês.')}</div><footer class="mt-4 border-t border-gray-100 pt-4"><div class="flex justify-between"><span class="text-sm text-gray-500">Total da fatura</span><strong>${money(total)}</strong></div><div class="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100"><div class="h-full bg-slate-500" style="width:${pct}%"></div></div></footer></div></article>`; }

function saveExpense(event) {
    event.preventDefault(); const description=$('expense-description').value.trim(), value=Number($('expense-value').value), date=$('expense-date').value, category=$('expense-category').value, method=$('expense-method').value, group=uid('group');
    if(editingRecordId) {
        const item=state.records.find(record=>String(record.id)===String(editingRecordId));
        if(item?.tipo==='cartao') {
            const card=state.cards.find(c=>String(c.id)===String($('expense-card').value));
            const installments=recordsInGroup(item).sort((a,b)=>(Number(a.parcela_atual)||0)-(Number(b.parcela_atual)||0));
            const selectedIndex=Math.max(0,installments.findIndex(record=>String(record.id)===String(item.id)));
            const firstDate=addMonths(date,-selectedIndex), portion=value/Math.max(installments.length,1);
            installments.forEach((record,index)=>Object.assign(record,{descricao:description,data:addMonths(firstDate,index),categoria:category,cardId:card?.id||item.cardId,cartao_nome:card?.name||item.cartao_nome,valor_total:value,valor_parcela:portion,quantidade_parcelas:installments.length,parcela_atual:index+1}));
        } else if(item) Object.assign(item,{descricao:description,valor:value,data:date,categoria:category,ciclo:$('expense-cycle').value});
        finishRecordEdit(event.target,item?.tipo==='cartao'?'Compra e todas as parcelas atualizadas.':'Despesa atualizada.'); return;
    }
    if(method==='cartao') {
        const card=state.cards.find(c=>String(c.id)===String($('expense-card').value)); if(!card)return showToast('Cadastre e selecione um cartão.');
        const purchaseType=$('card-purchase-type').value;
        if(purchaseType==='recurring') {
            const duration=$('recurring-duration').value, recurring={id:uid('subscription'),description,amount:value,category,cardId:card.id,cardName:card.name,frequency:$('recurring-frequency').value,startDate:date,endDate:duration==='until'?$('recurring-until').value:null,repeatCount:duration==='count'?Math.max(1,Number($('recurring-count').value)||1):null,generatedCount:0,status:'active',skippedSequences:[]};
            if(duration==='until'&&(!recurring.endDate||recurring.endDate<date))return showToast('Informe uma data final igual ou posterior à primeira cobrança.');
            state.recurringTransactions.push(recurring);ensureRecurringCharges(date.slice(0,7));
        } else {
            const installments=purchaseType==='installment'?Math.max(2,Number($('expense-installments').value)||2):1, portion=value/installments;
            for(let i=0;i<installments;i++) state.records.push({id:uid('purchase'),parent_id:group,purchaseGroupId:group,purchase_type:purchaseType,tipo:'cartao',cardId:card.id,cartao_nome:card.name,descricao:description,valor_total:value,valor_parcela:portion,quantidade_parcelas:installments,parcela_atual:i+1,data:addMonths(date,i),categoria:category,status_pagamento:false});
        }
    }
    else { const repeat=Math.max(1,Number($('expense-repeat').value)||1); for(let i=0;i<repeat;i++) state.records.push({id:uid('expense'),parent_id:group,tipo:'padrao',descricao:description,valor:value,data:addMonths(date,i),categoria:category,ciclo:$('expense-cycle').value,status_pagamento:false}); }
    saveState(); event.target.reset(); $('expense-date').value=todayIso(); $('expense-repeat').value=1;$('expense-installments').value=2;toggleExpenseMethod();toggleCardPurchaseType();toggleRecurringDuration();showToast('Despesa registrada.'); navigate('home');
}
function saveIncome(event) { event.preventDefault(); const repeat=Math.max(1,Number($('income-repeat').value)||1), group=uid('group'), description=$('income-description').value.trim(), value=Number($('income-value').value), date=$('income-date').value, category=$('income-category').value; if(editingRecordId){const item=state.records.find(record=>String(record.id)===String(editingRecordId));if(item){item.descricao=description;item.valor=value;item.data=date;item.categoria=category;item.scheduledIncome=date>todayIso();item.status_pagamento=date<=todayIso();}finishRecordEdit(event.target,'Receita atualizada.');return;} for(let i=0;i<repeat;i++){const incomeDate=addMonths(date,i);state.records.push({id:uid('income'),parent_id:group,tipo:'receita',descricao:description,valor:value,data:incomeDate,categoria:category,scheduledIncome:incomeDate>todayIso(),status_pagamento:incomeDate<=todayIso()});} saveState();event.target.reset();$('income-date').value=todayIso();$('income-repeat').value=1;showToast('Receita registrada.');navigate('home'); }
function saveCard(event) { event.preventDefault(); const editingId=$('card-edit-id').value, id=editingId||uid('card'), card={id,name:$('card-name').value.trim(),limit:Number($('card-limit').value),closingDay:Number($('card-close').value),dueDay:Number($('card-due').value),invoiceCycle:$('card-cycle').value}; const index=state.cards.findIndex(c=>String(c.id)===String(id)); if(editingId&&index>=0)state.cards[index]=card;else state.cards.push(card); saveState();resetCardForm();updateCardOptions();showToast(editingId?'Cartão atualizado.':'Novo cartão adicionado.');navigate('cards'); }
function editCard(id) { const card=state.cards.find(c=>String(c.id)===String(id)); if(!card)return; navigate('new');setRecordTab('card');$('card-edit-id').value=card.id;$('card-name').value=card.name;$('card-limit').value=card.limit;$('card-close').value=card.closingDay;$('card-due').value=card.dueDay;$('card-cycle').value=card.invoiceCycle||state.profile.invoiceCycle||'pagamento';$('card-form').querySelector('button').textContent='Atualizar cartão'; }

function startEditRecord(id) {
    const item=state.records.find(record=>String(record.id)===String(id)); if(!item)return;
    editingRecordId=item.id; editingRecordSourceView=currentView; navigate('new',true);
    if(item.tipo==='receita') { setRecordTab('income'); $('income-description').value=item.descricao;$('income-value').value=valueOf(item);$('income-date').value=item.data;$('income-category').value=item.categoria||'Outros';$('income-repeat').value=1;$('income-repeat').disabled=true;$('income-form').querySelector('button').textContent='Atualizar receita'; }
    else { const cardPurchase=item.tipo==='cartao', installments=cardPurchase?recordsInGroup(item):[item], total=cardPurchase?installments.reduce((sum,record)=>sum+valueOf(record),0):valueOf(item); setRecordTab('expense');$('expense-description').value=item.descricao;$('expense-value').value=total;$('expense-date').value=item.data;$('expense-category').value=item.categoria||'Outros';$('expense-method').value=cardPurchase?'cartao':'padrao';$('expense-cycle').value=item.ciclo||'pagamento';$('expense-repeat').value=1;$('expense-repeat').disabled=true;$('expense-method').disabled=true;$('expense-card').value=item.cardId||'';$('expense-card').disabled=cardPurchase;$('expense-installments').value=installments.length;$('expense-installments').disabled=cardPurchase;toggleExpenseMethod();$('expense-form').querySelector('button').textContent=cardPurchase?'Atualizar compra parcelada':'Atualizar despesa'; }
}
function resetRecordEditMode() { editingRecordId=null;editingRecordSourceView='home';$('expense-repeat').disabled=false;$('expense-method').disabled=false;$('expense-card').disabled=false;$('expense-installments').disabled=false;$('income-repeat').disabled=false;$('expense-form').querySelector('button').textContent='Salvar despesa';$('income-form').querySelector('button').textContent='Salvar receita'; }
function finishRecordEdit(form,message) { const destination=editingRecordSourceView==='cards'?'cards':'home';saveState();editingRecordId=null;editingRecordSourceView='home';form.reset();$('expense-repeat').disabled=false;$('expense-method').disabled=false;$('expense-card').disabled=false;$('expense-installments').disabled=false;$('income-repeat').disabled=false;$('expense-form').querySelector('button').textContent='Salvar despesa';$('income-form').querySelector('button').textContent='Salvar receita';$('expense-date').value=$('income-date').value=todayIso();showToast(message);navigate(destination); }

function fillSettings() { const p=state.profile,g=state.goals; $('settings-name').value=p.name;$('settings-email').value=p.email;$('settings-phone').value=p.phone;$('settings-birth').value=p.birth;$('settings-currency').value=p.currency;$('settings-salary').value=p.salary||'';$('settings-payday').value=p.payday||5;$('settings-advance-day').value=p.advanceDay||'';$('settings-invoice-cycle').value=p.invoiceCycle||'pagamento';$('settings-goal-name').value=g.name;$('settings-goal-value').value=g.target||'';$('settings-goal-saved').value=g.saved||'';['settings-goal-name','settings-goal-value','settings-goal-saved'].forEach(id=>$(id).closest('label').classList.add('hidden')); }
async function saveSettings(event) { event.preventDefault(); const previousEmail=state.profile.email; state.profile={...state.profile,name:$('settings-name').value.trim(),email:$('settings-email').value.trim(),phone:$('settings-phone').value.trim(),birth:$('settings-birth').value,salary:Number($('settings-salary').value)||0,payday:Number($('settings-payday').value)||5,advanceDay:Number($('settings-advance-day').value)||null,currency:$('settings-currency').value,invoiceCycle:$('settings-invoice-cycle').value}; const authUpdate={data:{name:state.profile.name,phone:state.profile.phone,birth:state.profile.birth,salary:state.profile.salary,payday:state.profile.payday,advanceDay:state.profile.advanceDay,currency:state.profile.currency}}; if(state.profile.email!==previousEmail)authUpdate.email=state.profile.email;if($('settings-password').value)authUpdate.password=$('settings-password').value;const{error}=await getClient().auth.updateUser(authUpdate);if(error)return showToast(error.message);$('settings-password').value='';ensureAutomaticIncome();ensureGoalContributions();saveState();$('sidebar-user').textContent=state.profile.name;showToast('Configurações atualizadas.');renderHome(); }

function changeMonth(direction) { currentDate=new Date(currentDate.getFullYear(),currentDate.getMonth()+direction,1);ensureAutomaticIncome();ensureRecurringCharges();ensureGoalContributions();saveState();if(currentView==='cards')renderCards();else renderHome(); }
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
function executeConfirmAction(action,id) { if(action==='pay')payItem(id); if(action==='unpay')unpayItem(id); if(action==='edit-record')startEditRecord(id); if(action==='edit-invoice')navigate('cards'); if(action==='delete-record')deleteRecord(id); if(action==='delete-card')deleteCard(id); if(action==='cancel-subscription')cancelSubscription(id); }
function payItem(id) { if(id.startsWith('invoice_')) { const invoice=invoiceItems().find(item=>item.id===id);if(!invoice)return;state.invoicePayments[invoice.invoiceKey]=true;invoice.purchases.forEach(p=>{p.status_pagamento=true;p.paymentDate=todayIso();}); } else { const item=state.records.find(r=>String(r.id)===String(id));if(item){item.status_pagamento=true;item.paymentDate=todayIso();} } saveState();showToast('Pagamento confirmado.');renderAll(); }
function unpayItem(id) { if(id.startsWith('invoice_')){const invoice=invoiceItems().find(item=>item.id===id);if(!invoice)return;delete state.invoicePayments[invoice.invoiceKey];invoice.purchases.forEach(item=>{item.status_pagamento=false;delete item.paymentDate;});}else{const item=state.records.find(record=>String(record.id)===String(id));if(!item)return;item.status_pagamento=false;delete item.paymentDate;}saveState();showToast('Pagamento desfeito. O item voltou para pendentes.');renderAll(); }
function deleteRecord(id) {
    const target=state.records.find(item=>String(item.id)===String(id));if(!target)return;
    if(target.recurring_transaction_id){
        const recurring=state.recurringTransactions.find(item=>item.id===target.recurring_transaction_id), choice=window.prompt('Excluir cobrança recorrente:\n1 - Somente esta cobrança\n2 - Esta e as próximas\n3 - Cancelar toda a assinatura','1');
        if(!['1','2','3'].includes(choice))return;
        if(choice==='1'){if(recurring&&!recurring.skippedSequences.includes(target.sequence_number))recurring.skippedSequences.push(target.sequence_number);state.records=state.records.filter(item=>String(item.id)!==String(id));}
        if(choice==='2'){if(recurring){recurring.endDate=addDays(target.data,-1);recurring.status='finished';}state.records=state.records.filter(item=>item.recurring_transaction_id!==target.recurring_transaction_id||item.sequence_number<target.sequence_number);}
        if(choice==='3'){if(recurring)recurring.status='cancelled';state.records=state.records.filter(item=>item.recurring_transaction_id!==target.recurring_transaction_id||item.data<target.data);}
        saveState();showToast(choice==='3'?'Assinatura cancelada.':'Cobrança recorrente excluída.');renderAll();return;
    }
    const groupedPurchase=target.tipo==='cartao'&&target.parent_id;
    if(groupedPurchase&&Number(target.quantidade_parcelas)>1){
        const choice=window.prompt('Excluir compra parcelada:\n1 - Somente esta parcela\n2 - Esta e as próximas\n3 - Todas as parcelas','1');if(!['1','2','3'].includes(choice))return;
        state.records=state.records.filter(item=>item.parent_id!==target.parent_id||(choice==='1'&&item.id!==target.id)||(choice==='2'&&Number(item.parcela_atual)<Number(target.parcela_atual)));
        saveState();showToast('Parcela(s) excluída(s).');renderAll();return;
    }
    state.records=state.records.filter(item=>String(item.id)!==String(id));saveState();showToast('Registro excluído.');renderAll();
}
function deleteCard(id) { const card=state.cards.find(item=>String(item.id)===String(id)); const hasPurchases=state.records.some(item=>item.tipo==='cartao'&&(String(item.cardId||'')===String(id)||(!item.cardId&&String(item.cartao_nome||'').toLowerCase()===String(card?.name||'').toLowerCase())));if(hasPurchases)return showToast('Exclua primeiro as compras vinculadas a este cartão.');state.cards=state.cards.filter(item=>String(item.id)!==String(id));saveState();updateCardOptions();showToast('Cartão excluído.');renderCards(); }
function renderAll() { if(currentView==='home')renderHome();if(currentView==='cards')renderCards();if(currentView==='goals')renderGoals();if(currentView==='settings')fillSettings();renderIcons(); }
function showToast(message) { const toast=document.createElement('div');toast.className='rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 shadow-lg';toast.textContent=message;$('toast-root').appendChild(toast);setTimeout(()=>toast.remove(),3200); }

document.addEventListener('DOMContentLoaded',()=>{applyTheme();setupAuthEvents();setupRecoveryFlow();initAuth();});
