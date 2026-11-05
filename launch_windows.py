"""Start the local app only after the listening socket is ready."""
from pathlib import Path
import shutil
import sys
import webbrowser


def main():
    root = Path(__file__).resolve().parent
    if not (root / '.env').exists():
        shutil.copyfile(root / '.env.example', root / '.env')

    import os
    os.environ.setdefault("PORT", "8006")
    import server

    if not Path(server.DATA_FILE).is_file():
        raise RuntimeError('未找到景点数据，请完整解压项目。')
    try:
        httpd = server.ThreadingHTTPServer(('127.0.0.1', server.PORT), server.Handler)
    except OSError as exc:
        raise RuntimeError('启动失败：端口可能被占用，请关闭已有的第六版启动窗口；第三版可以继续运行。') from exc

    with httpd:
        url = f'http://127.0.0.1:{httpd.server_port}'
        print('鲁趣寻踪 · 第六版已启动：' + url, flush=True)
        mode = '界面预览，使用模板文案，不调用真实模型' if server.LLM_MOCK else '真实模型模式（需要有效配置）'
        print('当前模式：' + mode, flush=True)
        print('使用期间请保留本窗口；按 Ctrl+C 停止。', flush=True)
        if '--check' in sys.argv:
            print('启动检查通过。', flush=True)
            return
        if '--no-browser' not in sys.argv:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('服务已停止。')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('启动失败：' + str(exc), file=sys.stderr)
        sys.exit(1)
