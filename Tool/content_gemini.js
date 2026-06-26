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
    if (block.getAttribute('data-btv-processed') === 'true') return;

    // 1. 블록 내 텍스트 전체 가져오기
    const text = block.textContent.trim();

    // 2. [핵심 로직] JSON인지 확인하고 "CREATE_CAMPAIGN_ASSETS" 액션이 있는지 검사
    let isTargetJson = false;
    try {
      // { 로 시작하고 } 로 끝나는 JSON 형태인지 먼저 체크
      if (text.startsWith('{') && text.endsWith('}')) {
        const parsed = JSON.parse(text);
        if (parsed && parsed.action === "CREATE_CAMPAIGN_ASSETS") {
          isTargetJson = true;
        }
      }
    } catch (e) {
      // 파싱 실패 시, text.includes를 통해 안전하게 한번 더 확인 (스트리밍 중인 경우)
      if (text.includes('"action": "CREATE_CAMPAIGN_ASSETS"') || text.includes('"action":"CREATE_CAMPAIGN_ASSETS"')) {
        isTargetJson = true;
      }
    }

    // 🎯 JSON 검증을 통과한 경우에만 버튼 주입
    if (isTargetJson) {
      if (!block.parentNode.querySelector('.btv-inject-btn')) {
        console.log("🎯 [B tv Extension] 정확한 JSON 타겟 발견!");
        injectButton(block);
        block.setAttribute('data-btv-processed', 'true');
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
