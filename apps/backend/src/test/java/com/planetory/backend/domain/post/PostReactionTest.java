package com.planetory.backend.domain.post;

import com.planetory.backend.domain.comment.service.CommentService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.domain.post.service.PostReactionService;
import com.planetory.backend.domain.post.service.PostService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
class PostReactionTest {
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");
    @DynamicPropertySource static void database(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", DB::getJdbcUrl);
        r.add("spring.datasource.username", DB::getUsername);
        r.add("spring.datasource.password", DB::getPassword);
    }
    @Autowired PostReactionService reactions;
    @Autowired PostService posts;
    @Autowired CommentService comments;
    @Autowired MemberService members;
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc mvc;
    @Autowired PlatformTransactionManager transactions;
    long owner, postId;

    @BeforeEach void seed() {
        owner = member();
        postId = Long.parseLong(posts.create(owner, new PostService.CreateCommand(
                "반응 테스트", "본문", "GENERAL", null, List.of(), List.of())).postId().substring(2));
    }

    long member() {
        return jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname) VALUES ('test',?,?) RETURNING id",
                Long.class, UUID.randomUUID().toString(), UUID.randomUUID().toString());
    }
    String path() { return "/api/v1/posts/p-" + postId; }
    MockHttpSession session(long id) {
        var session = new MockHttpSession();
        var context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(new TestingAuthenticationToken(new MemberPrincipal(id), null, "ROLE_USER"));
        session.setAttribute("SPRING_SECURITY_CONTEXT", context);
        session.setAttribute(com.planetory.backend.domain.auth.service.AuthSessionService.class.getName() + ".lastActivity", Instant.now());
        return session;
    }
    void error(ErrorCode code, Runnable action) {
        assertEquals(code, assertThrows(BusinessException.class, action::run).getErrorCode());
    }

    @Test void 최종상태와_반복요청은_멱등이며_상세와_수정은_요청회원의_실제합계를_반환한다() throws Exception {
        long other = member();
        reactions.put(other, postId, "DISAGREE");
        for (String state : List.of("NONE", "AGREE", "DISAGREE", "NONE")) {
            for (int retry = 0; retry < 2; retry++) {
                mvc.perform(put(path() + "/my-reaction").session(session(owner)).with(csrf())
                                .contentType("application/json").content("{\"reaction\":\"" + state + "\"}"))
                        .andExpect(status().isOk()).andExpect(jsonPath("$.postId").value("p-" + postId))
                        .andExpect(jsonPath("$.myReaction").value(state))
                        .andExpect(jsonPath("$.agree").value(state.equals("AGREE") ? 1 : 0))
                        .andExpect(jsonPath("$.disagree").value(state.equals("DISAGREE") ? 2 : 1));
                assertEquals(state.equals("NONE") ? 1 : 2,
                        jdbc.queryForObject("SELECT count(*) FROM post_reactions WHERE post_id=?", Integer.class, postId));
            }
        }
        reactions.put(owner, postId, "AGREE");
        var before = jdbc.queryForMap("SELECT id,updated_at FROM post_reactions WHERE post_id=? AND user_id=?", postId, owner);
        reactions.put(owner, postId, "AGREE");
        assertEquals(before, jdbc.queryForMap("SELECT id,updated_at FROM post_reactions WHERE post_id=? AND user_id=?", postId, owner));
        for (long viewer : List.of(owner, other)) {
            mvc.perform(get(path()).session(session(viewer))).andExpect(status().isOk())
                    .andExpect(jsonPath("$.reactionSummary.agree").value(1))
                    .andExpect(jsonPath("$.reactionSummary.disagree").value(1))
                    .andExpect(jsonPath("$.reactionSummary.myReaction").value(viewer == owner ? "AGREE" : "DISAGREE"));
        }
        mvc.perform(patch(path()).session(session(owner)).with(csrf()).contentType("application/json").content("{\"title\":\"수정\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.reactionSummary.agree").value(1))
                .andExpect(jsonPath("$.reactionSummary.disagree").value(1)).andExpect(jsonPath("$.reactionSummary.myReaction").value("AGREE"));
        for (String table : List.of("published_analyses", "user_candidate_achievements", "analysis_histories", "submissions", "star_unlocks")) {
            assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM " + table + " WHERE user_id=?", Integer.class, owner));
        }
    }

    @Test void 반응자_동률커서_페이지순회와_최신닉네임_조건검증() throws Exception {
        var expected = new ArrayList<String>();
        for (int i = 0; i < 5; i++) {
            long id = member();
            reactions.put(id, postId, "AGREE");
            expected.addFirst("u-" + id);
        }
        reactions.put(owner, postId, "DISAGREE");
        jdbc.update("UPDATE post_reactions SET updated_at='2026-09-21 01:00:00.123456+00' WHERE post_id=?", postId);
        long newest = Long.parseLong(expected.getFirst().substring(2));
        jdbc.update("UPDATE users SET nickname=? WHERE id=?", "최신_" + newest, newest);
        var first = reactions.list(postId, "AGREE", 2, null);
        assertEquals("최신_" + newest, first.items().getFirst().nickname());
        var found = new ArrayList<String>();
        String cursor = null;
        do {
            var page = reactions.list(postId, "AGREE", 2, cursor);
            found.addAll(page.items().stream().map(PostService.Author::memberId).toList());
            assertEquals(page.nextCursor() != null, page.hasNext());
            cursor = page.nextCursor();
        } while (cursor != null);
        assertEquals(expected, found);
        error(ErrorCode.VALIDATION_FAILED, () -> reactions.list(postId, "DISAGREE", 2, first.nextCursor()));
        error(ErrorCode.VALIDATION_FAILED, () -> reactions.list(postId, "AGREE", 3, first.nextCursor()));
        long another = Long.parseLong(posts.create(owner, new PostService.CreateCommand("다른글", "본문", "GENERAL", null, null, null)).postId().substring(2));
        error(ErrorCode.VALIDATION_FAILED, () -> reactions.list(another, "AGREE", 2, first.nextCursor()));
        for (String invalid : List.of("", "bad!", "MTIz", "LTE="))
            error(ErrorCode.VALIDATION_FAILED, () -> reactions.list(postId, "AGREE", 2, invalid));
        for (int size : List.of(0, 101)) error(ErrorCode.VALIDATION_FAILED, () -> reactions.list(postId, "AGREE", size, null));
        mvc.perform(get(path() + "/reactions").session(session(owner)).param("reaction", "AGREE").param("size", "2"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].nickname").value("최신_" + newest))
                .andExpect(jsonPath("$.hasNext").value(true));
        assertTrue(reactions.list(another, "AGREE", 20, null).items().isEmpty());
    }

    @Test void 숨김_삭제는_기존본인반응의_변경취소와_조회도_404이다() throws Exception {
        reactions.put(owner, postId, "AGREE");
        for (String status : List.of("hidden", "deleted")) {
            jdbc.update("UPDATE posts SET status=? WHERE id=?", status, postId);
            for (String state : List.of("AGREE", "DISAGREE", "NONE")) {
                mvc.perform(put(path() + "/my-reaction").session(session(owner)).with(csrf())
                                .contentType("application/json").content("{\"reaction\":\"" + state + "\"}"))
                        .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));
            }
            mvc.perform(get(path()).session(session(owner))).andExpect(status().isNotFound());
            mvc.perform(get(path() + "/reactions").session(session(owner)).param("reaction", "AGREE"))
                    .andExpect(status().isNotFound());
            error(ErrorCode.RESOURCE_NOT_FOUND, () -> reactions.summary(postId, owner));
        }
        assertEquals("agree", jdbc.queryForObject("SELECT reaction FROM post_reactions WHERE post_id=?", String.class, postId));
    }

    @Test void 인증_CSRF_활성회원과_입력경계를_검증한다() throws Exception {
        mvc.perform(get(path() + "/reactions").param("reaction", "AGREE")).andExpect(status().isUnauthorized());
        mvc.perform(put(path() + "/my-reaction").with(csrf()).contentType("application/json").content("{\"reaction\":\"AGREE\"}"))
                .andExpect(status().isUnauthorized());
        mvc.perform(put(path() + "/my-reaction").session(session(owner)).contentType("application/json").content("{\"reaction\":\"AGREE\"}"))
                .andExpect(status().isForbidden());
        for (String body : List.of("{}", "null", "[]", "{\"reaction\":null}", "{\"reaction\":1}", "{\"reaction\":\"agree\"}", "{\"reaction\":\"OTHER\"}")) {
            mvc.perform(put(path() + "/my-reaction").session(session(owner)).with(csrf()).contentType("application/json").content(body))
                    .andExpect(status().isBadRequest());
        }
        mvc.perform(get(path() + "/reactions").session(session(owner)).param("reaction", "NONE")).andExpect(status().isBadRequest());
        mvc.perform(get(path() + "/reactions").session(session(owner))).andExpect(status().isBadRequest());
        jdbc.update("UPDATE users SET status='withdrawn' WHERE id=?", owner);
        error(ErrorCode.AUTH_REQUIRED, () -> reactions.put(owner, postId, "AGREE"));
        mvc.perform(get(path() + "/reactions").session(session(owner)).param("reaction", "AGREE")).andExpect(status().isUnauthorized());
    }

    @Test void 여러회원과_같은회원의_동시최초요청은_한행씩_저장한다() throws Exception {
        var members = new ArrayList<Long>();
        for (int i = 0; i < 6; i++) members.add(member());
        try (var pool = Executors.newFixedThreadPool(8)) {
            var gate = new CountDownLatch(1);
            var futures = new ArrayList<Future<PostReactionService.Result>>();
            for (int i = 0; i < 12; i++) {
                long member = members.get(i % 6);
                futures.add(pool.submit(() -> { gate.await(); return reactions.put(member, postId, "AGREE"); }));
            }
            gate.countDown();
            for (var future : futures) future.get(15, TimeUnit.SECONDS);
        }
        assertEquals(new PostService.ReactionSummary(6, 0, "NONE"), reactions.summary(postId, owner));
        assertEquals(6, jdbc.queryForObject("SELECT count(*) FROM post_reactions WHERE post_id=?", Integer.class, postId));
    }

    @Test void 반응은_커밋순서로_저장되고_삭제경합은_글잠금을_따른다() throws Exception {
        try (var pool = Executors.newSingleThreadExecutor()) {
            var pending = new AtomicReference<Future<PostReactionService.Result>>();
            new TransactionTemplate(transactions).executeWithoutResult(tx -> {
                reactions.put(owner, postId, "AGREE");
                pending.set(pool.submit(() -> reactions.put(owner, postId, "DISAGREE")));
                awaitPostLock();
            });
            assertEquals("DISAGREE", pending.get().get(10, TimeUnit.SECONDS).myReaction());
            assertEquals(new PostService.ReactionSummary(0, 1, "DISAGREE"), reactions.summary(postId, owner));
            new TransactionTemplate(transactions).executeWithoutResult(tx -> {
                posts.delete(owner, postId);
                pending.set(pool.submit(() -> reactions.put(owner, postId, "NONE")));
                awaitPostLock();
            });
            var failure = assertThrows(ExecutionException.class, () -> pending.get().get(10, TimeUnit.SECONDS));
            assertEquals(ErrorCode.RESOURCE_NOT_FOUND, ((BusinessException) failure.getCause()).getErrorCode());
            assertEquals("disagree", jdbc.queryForObject("SELECT reaction FROM post_reactions WHERE post_id=?", String.class, postId));
        }
    }

    @Test void 반응이_먼저면_삭제는_그_커밋을_기다린다() throws Exception {
        try (var pool = Executors.newSingleThreadExecutor()) {
            var pending = new AtomicReference<Future<?>>();
            new TransactionTemplate(transactions).executeWithoutResult(tx -> {
                assertEquals("AGREE", reactions.put(owner, postId, "AGREE").myReaction());
                pending.set(pool.submit(() -> posts.delete(owner, postId)));
                awaitPostLock();
            });
            pending.get().get(10, TimeUnit.SECONDS);
            error(ErrorCode.RESOURCE_NOT_FOUND, () -> reactions.put(owner, postId, "AGREE"));
        }
    }

    @Test void 탈퇴가_먼저_확정되면_대기한_글과_후속_댓글_반응_설정은_거부한다() throws Exception {
        try (var pool = Executors.newSingleThreadExecutor()) {
            var pending = new AtomicReference<Future<?>>();
            new TransactionTemplate(transactions).executeWithoutResult(tx -> {
                jdbc.update("UPDATE users SET status='withdrawn', withdrawn_at=clock_timestamp() WHERE id=?", owner);
                pending.set(pool.submit(() -> posts.create(owner, new PostService.CreateCommand(
                        "탈퇴 경합", "본문", "GENERAL", null, List.of(), List.of()))));
                awaitPostLock();
            });
            var failure = assertThrows(ExecutionException.class, () -> pending.get().get(10, TimeUnit.SECONDS));
            assertEquals(ErrorCode.AUTH_REQUIRED, ((BusinessException) failure.getCause()).getErrorCode());
        }
        error(ErrorCode.AUTH_REQUIRED, () -> comments.create(owner, new CommentService.CreateCommand(
                CommentService.ParentType.POST, postId, "댓글", List.of(), List.of())));
        error(ErrorCode.AUTH_REQUIRED, () -> reactions.put(owner, postId, "AGREE"));
        error(ErrorCode.AUTH_REQUIRED, () -> members.changeStarListVisibility(owner, "PUBLIC"));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM posts WHERE user_id=? AND title='탈퇴 경합'", Integer.class, owner));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM comments WHERE user_id=?", Integer.class, owner));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM post_reactions WHERE user_id=?", Integer.class, owner));
    }

    @Test void 탈퇴한_반응자는_명단과_합계에서_함께_빠진다() {
        long active = member();
        reactions.put(owner, postId, "AGREE");
        reactions.put(active, postId, "AGREE");
        jdbc.update("UPDATE users SET status='withdrawn', withdrawn_at=clock_timestamp() WHERE id=?", owner);
        assertEquals(new PostService.ReactionSummary(1, 0, "AGREE"), reactions.summary(postId, active));
        var page = reactions.list(postId, "AGREE", 20, null);
        assertEquals(1, page.items().size());
        assertEquals("u-" + active, page.items().getFirst().memberId());
    }

    // sleep으로 저장 순서를 추측하지 않고 PostgreSQL이 실제로 다음 쓰기를 막는지 확인한다.
    void awaitPostLock() {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted "
                    + "AND pg_backend_pid()=ANY(pg_blocking_pids(pid)))", Boolean.class))) return;
            try { Thread.sleep(20); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError(e); }
        }
        fail("반응/삭제가 같은 글 행 잠금을 기다려야 한다");
    }

    @Test void 앱역할로_실제JPA_반응생성_변경_조회_취소를_수행한다() {
        new TransactionTemplate(transactions).executeWithoutResult(tx -> {
            jdbc.execute("SET LOCAL ROLE planetory_app");
            assertEquals("AGREE", reactions.put(owner, postId, "AGREE").myReaction());
            assertEquals("DISAGREE", reactions.put(owner, postId, "DISAGREE").myReaction());
            assertEquals(1, reactions.list(postId, "DISAGREE", 20, null).items().size());
            assertEquals("NONE", reactions.put(owner, postId, "NONE").myReaction());
        });
    }
}
