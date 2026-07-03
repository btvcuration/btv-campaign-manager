// 1. 기존 Jira 전송 신호 중계 (React -> Extension -> Jira)
window.addEventListener('TEST_JIRA_SEND', (e) => {
  chrome.runtime.sendMessage({
    action: "OPEN_JIRA_TEST",
    data: e.detail
  });
});

// 2. 네이티브 캡처 및 이미지 자르기(크롭)
window.addEventListener('REQUEST_SCREENSHOT', (e) => {
  const rect = e.detail; 
  
  // 백그라운드 카메라에 캡처 요청
  chrome.runtime.sendMessage({ action: "TAKE_SCREENSHOT" }, (response) => {
    if (!response || !response.dataUrl) {
      window.dispatchEvent(new CustomEvent('RECEIVE_SCREENSHOT', { detail: { dataUrl: null } }));
      return;
    }

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = rect.width;
      canvas.height = rect.height;
      const ctx = canvas.getContext('2d');

      const dpr = window.devicePixelRatio || 1;
      ctx.drawImage(img, rect.x * dpr, rect.y * dpr, rect.width * dpr, rect.height * dpr, 0, 0, rect.width, rect.height);
      
      const croppedDataUrl = canvas.toDataURL('image/png');
      window.dispatchEvent(new CustomEvent('RECEIVE_SCREENSHOT', { detail: { dataUrl: croppedDataUrl } }));
    };
    img.onerror = () => {
      window.dispatchEvent(new CustomEvent('RECEIVE_SCREENSHOT', { detail: { dataUrl: null } }));
    };
    img.src = response.dataUrl;
  });
});

// 🌟 3. [신규 추가] 백그라운드에서 전달된 AI 데이터를 받아서 React 웹 페이지(window)로 패스
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "INJECT_AI_DATA") {
    // React 앱에서 수신 대기 중인 이벤트 이름('RECEIVE_AI_DATA')으로 발송
    window.dispatchEvent(new CustomEvent('RECEIVE_AI_DATA', { 
      detail: message.payload 
    }));
  }
});

// 🌟 [NEW] Gemini 화면에 실시간 Capa 주입용 플로팅 버튼 생성
function injectCapaButton() {
  // 이미 버튼이 있으면 중복 생성 방지
  if (document.getElementById('capa-inject-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'capa-inject-btn';
  btn.innerHTML = '🚀 실시간 Capa 연동';
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '100px', // Gemini 기본 전송 버튼과 안 겹치게 적절한 위치 조정
    right: '30px',
    padding: '12px 20px',
    backgroundColor: '#ff9900', // 눈에 띄는 주황색
    color: '#fff',
    border: 'none',
    borderRadius: '30px',
    fontWeight: 'bold',
    cursor: 'pointer',
    zIndex: '9999',
    boxShadow: '0 4px 6px rgba(0,0,0,0.2)'
  });

  btn.addEventListener('click', () => {
    // 1. Gemini의 입력창(contenteditable 요소) 찾기
    const inputBox = document.querySelector('div[role="textbox"][contenteditable="true"]') || document.querySelector('.ql-editor');
    
    if (!inputBox) {
      alert("입력창을 찾을 수 없습니다. Gemini 대화창인지 확인해 주세요.");
      return;
    }

    const userText = inputBox.innerText || inputBox.textContent || '';
    if (userText.trim() === '') {
      alert("먼저 기획 요청 내용을 입력창에 작성해 주세요!\n(예: 7월 7일 50만 타겟 월정액 프로모션 기획해줘)");
      return;
    }

    const originalBtnText = btn.innerHTML;
    btn.innerHTML = '⏳ 데이터 불러오는 중...';

    // 2. background.js를 통해 실시간 CSV 데이터 가져오기
    chrome.runtime.sendMessage({ action: 'fetchCapaCsv' }, (response) => {
      btn.innerHTML = originalBtnText;

      if (!response.success) {
        alert("Capa 데이터를 불러오는데 실패했습니다: " + response.error);
        return;
      }

      // 3. 매니저님의 질문 뒤에 CSV 데이터를 숨겨진 프롬프트 형태로 조립
      const injectionText = `\n\n[시스템 자동 주입: 실시간 Capa 데이터 (잔여 슬롯 기준: 270만)]\n\`\`\`csv\n${response.data}\n\`\`\`\n★ 위 데이터를 바탕으로 일별 잔여 슬롯을 계산하여 실현 가능한 일정을 검증하고 기획안을 작성할 것.`;

      // 4. 입력창에 텍스트 강제 주입
      inputBox.focus();
      document.execCommand('insertText', false, injectionText);
      
      // 5. 💡 [NEW] 텍스트 주입 0.1초 뒤 자동 전송 (Gemini 전송 버튼 클릭 또는 Enter 트리거)
      setTimeout(() => {
        // Gemini 하단의 전송 버튼(종이비행기 아이콘) 요소를 찾아 클릭 시도
        const sendBtn = document.querySelector('button[aria-label="메시지 전송"]') || 
                        document.querySelector('button[aria-label="Send message"]');
        
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else {
          // 전송 버튼을 찾지 못한 경우 키보드 Enter 이벤트 강제 발생
          const enterEvent = new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Enter',
            code: 'Enter',
            keyCode: 13
          });
          inputBox.dispatchEvent(enterEvent);
        }
      }, 100); // React가 텍스트 입력을 인식할 수 있도록 아주 짧은 딜레이(100ms) 부여
    });
  });

  document.body.appendChild(btn);
}

// React 기반인 Gemini 화면이 전환될 때마다 버튼이 유지되도록 MutationObserver 사용
const observer = new MutationObserver(() => {
  // Gemini 도메인에서만 작동하도록 안전장치
  if (window.location.hostname.includes('gemini.google.com')) {
    injectCapaButton();
  }
});
observer.observe(document.body, { childList: true, subtree: true });
