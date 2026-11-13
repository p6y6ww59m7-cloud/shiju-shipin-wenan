export function downloadIssue(error) {
  const text=String(error?.message || error || '');
  if (/sign in to confirm|confirm you.re not a bot|captcha|verify (?:you|your)|验证码|安全验证|人机验证/i.test(text)) return 'verification';
  if (/login required|log[ -]?in (?:is )?required|sign[ -]?in (?:is )?required|sign in|not logged in|authentication required|use --cookies|需要登录|请先登录|登录后/i.test(text)) return 'login';
  if (/video (?:is )?unavailable|not available|has been (?:removed|deleted)|404|DRM|copyright|作品不存在|作品已删除|视频不见了/i.test(text)) return 'unavailable';
  if (/timed? out|timeout|connection (?:refused|reset|closed)|network|unable to download webpage|HTTP Error 5\d\d|网络|连接失败/i.test(text)) return 'network';
  return 'unknown';
}

export function pageGate(page) {
  const text=page.text || '', dialogs=(page.dialogs || []).join('\n');
  if (page.challenge || /请完成.{0,12}验证|拖动滑块|安全验证|人机验证|verify (?:you|your)|confirm you.re not a bot|checking your browser/i.test(dialogs)) return 'verification';
  if(text.length<1500 && /请完成.{0,12}验证|拖动滑块|安全验证|人机验证|verify (?:you|your)|confirm you.re not a bot/i.test(text))return 'verification';
  if (page.password || /扫码登录|验证码登录|登录后观看|登录后继续|sign in to continue|log in to continue/i.test(dialogs)) return 'login';
  if (/请先登录.{0,15}(?:观看|播放)|登录后(?:才能|即可|继续)(?:观看|播放)|sign in to (?:watch|confirm)|log in to (?:watch|continue)/i.test(text)) return 'login';
  return null;
}
