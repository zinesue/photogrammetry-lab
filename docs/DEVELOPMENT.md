# 검증·패키징·버전 관리

## 환경

- 소스 실행과 Python 테스트: Python 3.12 이상, 표준 라이브러리
- JavaScript 테스트: Node.js 22 이상, 기본 테스트 도구
- Windows 배포본 생성: Windows 64비트, Python 3.12, `requirements-build.txt`
- PNG 예제 재생성: Pillow (실행에는 필요 없음)

아래 명령은 `photogrammetry` 폴더에서 실행합니다.

## 테스트

```console
python -B -m unittest discover -s tests -p "test_*.py"
node --test tests/test_depth.js tests/test_model_view.js tests/test_photo_controls.js tests/test_spatial.js tests/test_window_lifetime.js
```

테스트는 `tests/fixtures`의 완전히 가상인 카메라와 관측값을 사용합니다. Python 테스트의 임시 관측 기록은 임시 폴더에 저장합니다. 기본 실행 설정은 가상 예제로 유지한 상태에서 테스트하세요.

검증 범위는 공간 전방교회, 독립적인 핀홀 수식과의 비교, 잘못된 관측 거부, 가이드 높이 계산, 저장·불러오기, HTTP 응답, CSV/DXF, 지형·등고선, 3D 가림, 화면 조작과 Windows 실행 수명 관리입니다. 실제 수업 자료의 위치·보정 정확도 검증은 포함하지 않습니다.

공개본의 검증용 관측값과 과거 저장 형식 예제도 가상으로 만들었습니다. 실제 영상에서 추출한 대응점과 이전 수업 기록을 포함하지 않습니다.

## 가상 예제 재생성

```console
python -m pip install Pillow==12.0.0
python tools/generate_synthetic.py
```

예제 PNG, 가상 카메라 파일, 기준점 및 테스트 자료를 다시 만듭니다. 현재 `photogrammetry/project.json`은 덮어쓰지 않습니다. 기본 예제로 복구하려면 `examples/synthetic/project.json`을 `photogrammetry/project.json`으로 복사합니다.

## Windows 공개 배포본 만들기

```console
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements-build.txt
.venv\Scripts\python tools/build_package.py
```

결과는 `dist/photogrammetry-v1.0.0-windows-synthetic.zip`입니다. 다른 위치에 저장하려면 `--output-dir` 뒤에 폴더를 지정합니다.

이 ZIP에는 실행 파일, 가상 데이터 두 장, 가상 cam/eo, 설명, 구성요소 라이선스 고지가 들어갑니다. 프로그램 소스, 실제 수업 자료, 측정 기록, 캐시는 포함하지 않습니다. 공개용 데이터는 `examples/synthetic`의 정해진 파일만 가져옵니다. 이 폴더에 실제 자료를 넣지 마세요.

패키징 과정의 작업 파일은 `work/packaging`에 생깁니다. 재패키징할 때 기존 `work/packaging/public/Pack`이 비어 있지 않으면 멈춥니다. 그 폴더를 별도 보관한 후 다시 빌드하세요. 기존 배포 폴더의 자료가 새 공개본에 섞이는 일을 방지하기 위한 동작입니다.

실행 파일은 `tools/portable_app.py`에서 시작하여 같은 `server.py`, `photogrammetry.py`, `terrain.py`, `web` 파일을 사용합니다. 이 도구가 포함 구성요소의 라이선스 고지도 수집합니다.

## 버전과 GitHub Releases

프로그램별로 별도 태그를 사용합니다.

- 사진측량 첫 공개: `photogrammetry-v1.0.0`
- 시뮬레이터 첫 공개: `projection-v1.0.0`
- 오류 수정 예: `photogrammetry-v1.0.1`
- 기능 추가 예: `photogrammetry-v1.1.0`

배포할 원본의 변경 내용을 저장한 다음, 그 원본으로 실행 파일을 다시 만들고 같은 버전의 Release에 첨부합니다. 다음 버전을 만들 때에는 빌드 도구 안의 버전 정보와 ZIP 이름, README의 안내도 함께 갱신합니다.

실행 파일과 배포 ZIP은 일반 코드 폴더에 올리지 않습니다. 같은 저장소의 Releases에 첨부합니다. GitHub가 자동 제공하는 Source code.zip에는 Windows 실행 파일이 없다는 점을 사용자에게 안내합니다.

## 공개용 복사본에 적용한 변경

핵심 측량 계산과 지형 계산은 기존 프로그램을 유지했습니다. 공개용 복사본에서는 가상 예제 설정, 독립 가상 테스트 자료, 현재 자료에 맞는 좌표계 표시, 일반 Python 실행 경로, 가상 데이터만 포함하는 패키징을 적용했습니다. 포트 자동 선택 시 실제 배정된 주소를 열도록 서버 시작 안내도 조정했습니다.

드론 투영 시뮬레이터 HTML의 동작 코드는 그대로 유지하고 파일명을 `index.html`로 정리했습니다.
