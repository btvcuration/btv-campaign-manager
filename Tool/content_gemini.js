console.log("🟢 [B tv Extension] Gemini 페이지 감시를 시작합니다. (강화형)");

// 1. Mermaid 초기화 세팅
if (typeof mermaid !== 'undefined') {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'loose', // 🚨 HTML 태그 렌더링 허용을 위해 필수
    themeVariables: {
      primaryColor: '#f4f5ff',
      primaryTextColor: '#333',
      primaryBorderColor: '#4f3df6',
      lineColor: '#adb5bd',
      secondaryColor: '#ff9900',
      tertiaryColor: '#4f3df6'
    }
  });
}

const observer = new MutationObserver((mutations) => {
  const codeBlocks = document.querySelectorAll('pre'); 

  codeBlocks.forEach(block => {
    // 🚨 텍스트 추출 시 innerText 대신 textContent를 사용하여 줄바꿈 유실 방지
    const codeElement = block.querySelector('code');
    const text = block.textContent || "";
    const codeText = codeElement ? codeElement.textContent.trim() : '';

    // 🎯 기능 A: 캠페인 JSON 데이터 전송 버튼 주입
    // (클래스명 검사 폐지: CREATE_CAMPAIGN_ASSETS 키워드만 있으면 무조건 감지)
    if (text.includes('CREATE_CAMPAIGN_ASSETS')) {
      // Gemini의 React 렌더링으로 인해 버튼이 삭제되었는지 실시간 확인
      const prevSibling = block.previousElementSibling;
      const hasButton = prevSibling && prevSibling.classList.contains('btv-inject-btn');

      if (!hasButton) {
        console.log("🎯 [B tv Extension] 타겟 JSON 발견! 버튼 주입");
        injectButton(block); // 텍스트를 넘기지 않고 블록 참조만 넘김 (클릭 시 최신 텍스트를 읽기 위함)
      }
    }

    // 🎨 기능 B: Mermaid 마크다운 감지 및 시각화 렌더링
    // Mermaid는 렌더링 후 DOM을 완전히 바꾸므로 data 속성으로 중복 실행 방지
    const isMermaid = (codeElement && (codeElement.className.includes('mermaid') || codeElement.className.includes('language-mermaid'))) ||
                      codeText.startsWith('graph ') ||
                      codeText.startsWith('flowchart ');

    if (isMermaid && block.getAttribute('data-mermaid-processed') !== 'true') {
      block.setAttribute('data-mermaid-processed', 'true');

      const uniqueId = 'mermaid-' + Math.random().toString(36).substr(2, 9);
      const graphContainer = document.createElement('div');
      graphContainer.id = uniqueId;
      graphContainer.style.cssText = `
        background: white; padding: 20px; border-radius: 12px; 
        border: 1px solid #e0e4ff; margin: 15px 0;
        box-shadow: 0 8px 16px rgba(79, 61, 246, 0.08); text-align: center;
        overflow-x: auto;
      `;

      block.style.display = 'none'; 
      block.parentNode.insertBefore(graphContainer, block.nextSibling);

      // Mermaid 렌더링 전 문법 사전 검증 (Syntax Error 이미지 덮어쓰기 방지)
      try {
        mermaid.parse(codeText).then((isValid) => {
            if(isValid) {
                mermaid.render(uniqueId + '-svg', codeText).then((result) => {
                  graphContainer.innerHTML = `
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:15px;">
                      <span style="background:#4f3df6; color:white; padding:4px 8px; border-radius:6px; font-size:12px; font-weight:bold;">UX</span>
                      <h3 style="margin:0; color:#111; font-size:16px; font-weight:bold;">B tv 고객 유저 플로우</h3>
                    </div>
                    ${result.svg}
                  `;
                }).catch(err => { throw err; });
            }
        }).catch((err) => {
            console.warn("⚠️ Mermaid 파싱 에러 (원본 텍스트 유지):", err);
            block.style.display = 'block'; 
            graphContainer.remove(); 
            const errorSvg = document.getElementById(uniqueId + '-svg');
            if (errorSvg) errorSvg.remove();
        });
      } catch (e) {
        console.error("Mermaid 렌더링 예외:", e);
        block.style.display = 'block'; 
        graphContainer.remove();
      }
    }
  });
});

// JSON 전송 버튼 주입 함수
function injectButton(targetBlock) {
  // 혹시라도 엉뚱한 곳에 남아있는 좀비 버튼 제거
  const existingBtn = targetBlock.parentNode.querySelector('.btv-inject-btn');
  if (existingBtn) existingBtn.remove();

  const btn = document.createElement('button');
  btn.className = 'btv-inject-btn';
  btn.style.cssText = `
    display: flex; align-items: center; justify-content: center; gap: 8px;
    margin-bottom: 12px; padding: 10px 20px;
    background: linear-gradient(90deg, #4f3df6, #7387ff); color: white;
    border: none; border-radius: 8px; font-weight: bold; font-size: 14px;
    cursor: pointer; width: 100%; box-shadow: 0 4px 10px rgba(115, 135, 255, 0.3); z-index: 9999;
  `;
  btn.innerHTML = '🚀 B tv 캠페인 툴로 전송 및 시안 생성';

  let isSending = false;

  btn.onclick = () => {
    if (isSending) return; 
    isSending = true;

    try {
      // 🚨 핵심: 버튼이 렌더링된 과거 시점의 텍스트가 아닌, '클릭한 현재 시점'의 완성된 텍스트를 가져옴
      const currentText = targetBlock.textContent || "";
      const startIndex = currentText.indexOf('{');
      const endIndex = currentText.lastIndexOf('}');
      if (startIndex === -1 || endIndex === -1) throw new Error("JSON 괄호({})를 찾을 수 없습니다.");

      const pureJsonText = currentText.substring(startIndex, endIndex + 1);
      const parsedData = JSON.parse(pureJsonText);
      
      chrome.runtime.sendMessage({ action: "TRANSFER_DATA_TO_CAMPAIGN_TOOL", payload: parsedData });

      btn.innerHTML = '✅ 전송 완료! (캠페인 툴 확인)';
      btn.style.background = '#28a745';
      
      setTimeout(() => {
        btn.innerHTML = '🚀 B tv 캠페인 툴로 전송 및 시안 생성';
        btn.style.background = 'linear-gradient(90deg, #4f3df6, #7387ff)';
        isSending = false; 
      }, 3000);

    } catch (e) {
      alert("🚨 JSON 파싱 에러!\nAI가 아직 답변을 작성 중이거나 코드 포맷이 깨졌을 수 있습니다.\n답변이 완전히 끝난 후 다시 클릭해주세요.");
      console.error("JSON 파싱 에러 상세:", e);
      isSending = false; 
    }
  };
  
  targetBlock.parentNode.insertBefore(btn, targetBlock);
}

observer.observe(document.body, { childList: true, subtree: true });
