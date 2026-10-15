const input = document.querySelector('#messageInput');
const count = document.querySelector('#characterCount');
const rewriteButton = document.querySelector('#rewriteButton');
const resultsSection = document.querySelector('#resultsSection');
const analysisStrip = document.querySelector('#analysisStrip');
const resultCards = document.querySelector('#resultCards');
const resetButton = document.querySelector('#resetButton');
const toast = document.querySelector('#toast');

const escapeHtml = value => value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const showToast = text => { toast.textContent = text; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2200); };

input.addEventListener('input', () => { count.textContent = `${input.value.length} / 500`; });

async function requestAnalysis(message) {
  const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const failure = new Error(`analysis_request_failed_${response.status}`);
    failure.code = error.error;
    throw failure;
  }
  const result = await response.json();
  if (!result || !['good', 'improve'].includes(result.status) || !Array.isArray(result.suggestions)) throw new Error('invalid_analysis_response');
  return result;
}

function copyButton(button, text) {
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); } catch { window.prompt('아래 문장을 복사해 주세요.', text); }
    button.classList.add('copied'); button.innerHTML = '<span class="copy-icon">✓</span> 복사했어요'; showToast('문장을 클립보드에 복사했어요');
  });
}

function renderAnalysis(result, original) {
  const level = result.status === 'good' ? 'green' : 'yellow';
  const label = result.status === 'good' ? '그대로 보내도 괜찮아요' : '조금 다듬는 것을 추천해요';
  analysisStrip.innerHTML = `<div class="assessment assessment-${level}"><span class="assessment-dot">●</span><strong>${label}</strong><span>${escapeHtml(result.summary)}</span></div><div class="analysis-details"><div><b>의도</b>${escapeHtml(result.intent)}</div><div><b>말투와 감정</b>${escapeHtml(result.tone)}</div><div><b>AI 분석</b>${escapeHtml(result.analysis)}</div></div>`;
  if (!result.suggestions.length) {
    resultCards.innerHTML = `<article class="result-card natural-card" style="--card-color:#8fcaac"><div class="card-label"><span class="card-icon">✓</span>원문 그대로</div><p class="result-text">${escapeHtml(original)}</p><button class="copy-button" type="button"><span class="copy-icon">▣</span> 복사하기</button></article>`;
    copyButton(resultCards.querySelector('.copy-button'), original);
    return;
  }
  resultCards.innerHTML = result.suggestions.map((suggestion, index) => `<article class="result-card" style="--card-color:${index ? '#9eb5d9' : '#d9a6c8'}"><div class="card-label"><span class="card-icon">${index ? '↗' : '✦'}</span>${escapeHtml(suggestion.label)}</div><p class="result-text">${escapeHtml(suggestion.text)}</p><button class="copy-button" type="button"><span class="copy-icon">▣</span> 복사하기</button></article>`).join('');
  resultCards.querySelectorAll('.copy-button').forEach((button, index) => copyButton(button, result.suggestions[index].text));
}

rewriteButton.addEventListener('click', async () => {
  const message = input.value.trim();
  if (!message) { input.focus(); showToast('먼저 보내려던 말을 적어주세요'); return; }
  if (message.length > 500) { showToast('메시지는 500자 이내로 적어주세요'); return; }
  rewriteButton.disabled = true;
  rewriteButton.querySelector('span:first-child').textContent = 'AI가 문장을 분석하는 중…';
  resultsSection.hidden = false;
  analysisStrip.innerHTML = '';
  resultCards.innerHTML = '<div class="loading-card">AI가 문장의 뜻과 감정을 살펴보는 중<div class="loading-dots"><span></span><span></span><span></span></div></div>';
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try { renderAnalysis(await requestAnalysis(message), message); }
  catch (error) { console.error('AI analysis request failed:', error); const message = error.code === 'quota_exceeded' ? 'AI 분석 사용량이 일시적으로 초과되었습니다. 잠시 후 다시 시도해주세요.' : 'AI 분석에 실패했어요. 잠시 후 다시 시도해주세요.'; analysisStrip.innerHTML = `<div class="assessment assessment-red"><span class="assessment-dot">●</span><strong>분석 실패</strong><span>${message}</span></div>`; resultCards.innerHTML = ''; }
  finally { rewriteButton.disabled = false; rewriteButton.querySelector('span:first-child').textContent = '오답노트 돌려보기'; }
});

resetButton.addEventListener('click', () => { input.value = ''; count.textContent = '0 / 500'; resultsSection.hidden = true; input.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
