# -*- coding: utf-8 -*-
"""AstroNet-Triage 평가 세트 구성과 201/61 입력 변환 (Jira S15P21C206-43, 계획 ID D10).

- labels: PC/EB/junk 라벨 목록과 TIC 단위 분리
- views: 위상 접기와 global(201)/local(61) 중앙값 view (40번 prepare 스크립트 규칙)
- bls: 잡음 곡선의 최강 피크(junk 후보)와 알려진 주기의 epoch·duration 산출
- convert: fixture 곡선 → 전처리 → 후보별 NPZ, 실패 기록, manifest
"""
