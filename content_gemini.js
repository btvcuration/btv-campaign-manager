console.log("🟢 [B tv Extension] Gemini 페이지 감시를 시작합니다.");

// 1. Mermaid 초기화 세팅
if (typeof mermaid !== 'undefined') {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
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

    const text = block.innerText || block.textContent;

    // 🎯 기능 A: 캠페인 JSON 데이터 전송 버튼 주입
    if (text && text.includes('"CREATE_CAMPAIGN_ASSETS"')) {
      if (!block.parentNode.querySelector('.btv-inject-btn')) {
        console.log("🎯 [B tv Extension] 타겟 JSON 발견!");
        injectButton(block, text);
        block.setAttribute('data-btv-processed', 'true');
      }
    }

    // 🎨 기능 B: Mermaid 마크다운 감지 및 시각화 렌더링 (인식 로직 대폭 강화)
    const codeElement = block.querySelector('code');
    const codeText = codeElement ? codeElement.innerText.trim() : '';

    // 제미나이가 언어 태그를 빼먹어도, 시작 단어가 graph나 flowchart면 무조건 렌더링
    const isMermaid = (codeElement && (codeElement.className.includes('mermaid') || codeElement.className.includes('language-mermaid'))) ||
                      codeText.startsWith('graph ') ||
                      codeText.startsWith('flowchart ');

    if (isMermaid) {
      block.setAttribute('data-btv-processed', 'true');

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

      try {
        mermaid.render(uniqueId + '-svg', codeText).then((result) => {
          graphContainer.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:15px;">
              <span style="background:#4f3df6; color:white; padding:4px 8px; border-radius:6px; font-size:12px; font-weight:bold;">UX</span>
              <h3 style="margin:0; color:#111; font-size:16px; font-weight:bold;">B tv 고객 유저 플로우</h3>
            </div>
            ${result.svg}
          `;
        });
      } catch (e) {
        console.error("Mermaid 렌더링 에러:", e);
        block.style.display = 'block'; 
        graphContainer.remove();
      }
    }
  });
});

// JSON 전송 버튼 주입 함수
function injectButton(targetBlock, jsonText) {
  const btn = document.createElement('button');
  btn.className = 'btv-inject-btn';
  btn.style.cssText = `
    display: flex; align-items: center; justify-content: center; gap: 8px;
    margin-top: 12px; margin-bottom: 12px; padding: 10px 20px;
    background: linear-gradient(90deg, #4f3df6, #7387ff); color: white;
    border: none; border-radius: 8px; font-weight: bold; font-size: 14px;
    cursor: pointer; width: 100%; box-shadow: 0 4px 10px rgba(115, 135, 255, 0.3); z-index: 9999;
  `;
  btn.innerHTML = '🚀 B tv 캠페인 툴로 전송 및 시안 생성';

  btn.onclick = () => {
    try {
      const startIndex = jsonText.indexOf('{');
      const endIndex = jsonText.lastIndexOf('}');
      if (startIndex === -1 || endIndex === -1) throw new Error("JSON 형태 오류");

      const pureJsonText = jsonText.substring(startIndex, endIndex + 1);
      const parsedData = JSON.parse(pureJsonText);
      
      chrome.runtime.sendMessage({ action: "TRANSFER_DATA_TO_CAMPAIGN_TOOL", payload: parsedData });

      btn.innerHTML = '✅ 전송 완료! (캠페인 툴 확인)';
      btn.style.background = '#28a745';
      setTimeout(() => {
        btn.innerHTML = '🚀 B tv 캠페인 툴로 전송 및 시안 생성';
        btn.style.background = 'linear-gradient(90deg, #4f3df6, #7387ff)';
      }, 3000);
    } catch (e) {
      alert("🚨 JSON 파싱 에러! F12 콘솔 확인");
      console.error(e);
    }
  };
  targetBlock.parentNode.insertBefore(btn, targetBlock.nextSibling);
}

observer.observe(document.body, { childList: true, subtree: true });