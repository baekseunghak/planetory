package com.planetory.backend.global.security;

import java.io.Serializable;
import java.security.Principal;

/** 세션에는 내부 회원 ID만 보관한다. 닉네임·역할·상태는 DB의 최신 값을 사용한다. */
public record MemberPrincipal(long memberId) implements Principal, Serializable {
    @Override public String getName() { return Long.toString(memberId); }
}
