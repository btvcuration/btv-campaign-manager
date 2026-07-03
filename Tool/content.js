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
