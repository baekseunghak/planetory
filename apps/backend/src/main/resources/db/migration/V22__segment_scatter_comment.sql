-- S15P21C206-123: descriptive correction only; no column type or data changes.
COMMENT ON COLUMN light_curve_segments.flux_scatter IS
'세그먼트의 유한 비닝 flux 전체에 대한 1.4826 × MAD. 무차원 상대 flux이며 통과·별 변동 포함. 점별 측정 오차·통과 밖 잡음·역분산 가중치가 아님';
