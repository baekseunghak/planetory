# 분석실 배경 이미지 출처

분석실의 항성 배경은 **NASA/SDO가 관측한 태양의 극자외선 영상**이다. 선택 대상인 TOI-270의 사진이 아니며, 관측 곡선·행성 매칭에 사용하는 자료도 아니다. 항성의 표면과 코로나를 보여주는 분위기용 참고 배경으로 사용한다. 황금색은 AIA 171 Å 파장 영상의 표현색으로, 가시광 사진의 실제 색을 뜻하지 않는다.

| 항목            | 값                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| 원본 제목       | The Active Sun from SDO: 171 Ångstroms                                                                               |
| 공식 출처       | [NASA Scientific Visualization Studio, ID 3980](https://svs.gsfc.nasa.gov/3980/)                                     |
| 관측 자료       | SDO / AIA 171 Å; 출처 페이지의 관측 범위 2011-09-25 08:00 ~ 2011-09-26 01:00                                         |
| 공개일          | 2012-11-20                                                                                                           |
| 실제 이미지 URL | [SDOAIA171A_Jewelbox.01000.jpg](https://svs.gsfc.nasa.gov/vis/a000000/a003900/a003980/SDOAIA171A_Jewelbox.01000.jpg) |
| 로컬 자산       | `public/images/star-background.jpg`                                                                                  |
| 원본 크기       | 4096 × 4096 px, JPEG, 2,245,814 bytes                                                                                |
| SHA-256         | `56a1f776e072b3410deb0949ed532de65ea04d1dc513e39aa6cd2428817f2387`                                                   |
| 확보일          | 2026-09-10                                                                                                           |

출처가 요청하는 크레딧: NASA/Goddard Space Flight Center Scientific Visualization Studio, the SDO Science Team, and the Virtual Solar Observatory.

사용 근거: [SDO Copyright Permissions](https://sdo.gsfc.nasa.gov/gallery/copyright/)는 별도 표시가 없는 SDO 이미지·영상에 저작권이 없으며 교육·정보 목적의 비상업적 사용에 별도 허가가 필요하지 않다고 안내한다. 해당 자료 페이지에는 별도의 제삼자 저작권 제한이 표시되어 있지 않다. [NASA Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)에 따라 출처를 밝히고 NASA의 협력·검토·보증을 암시하지 않는다. 자체 CC 라이선스를 부여한 자료로 표기하지 않는다.

원본 JPEG는 재인코딩하거나 합성하지 않았다. `src/background.css`에서 표시 크기·위치·채도·투명도·마스크·어두운 덮개만 적용한다. 원반을 패널보다 크게 배치하고 패널 투명도를 낮춰 태양의 가장자리와 코로나가 보이게 한다. UI 출처 표시는 `태양 참고 배경 · NASA/SDO`로 구분한다.

적용 시 `src/main.jsx`의 `styles.css` import 다음에 `import "./background.css";`를 둔다. 배경은 기존 `aria-hidden="true"` 장식용 `.room` 안의 CSS 가상 요소라 차트·폼의 접근성 의미를 바꾸지 않는다.
