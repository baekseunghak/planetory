package com.planetory.backend.domain;

/** 전역 별 게시판 공개 자격. %s에는 코드에 고정된 TIC 열 또는 바인딩 자리만 넣는다. */
public final class StarBoardVisibility {
    public static final String OPEN = "EXISTS (SELECT 1 FROM stars board_star WHERE board_star.tic_id=%s "
            + "AND board_star.service_status='published' "
            + "AND EXISTS (SELECT 1 FROM star_unlocks board_unlock WHERE board_unlock.tic_id=board_star.tic_id))";

    private StarBoardVisibility() {}
}
