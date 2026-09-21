package com.planetory.backend.domain.comment.repository;

import com.planetory.backend.domain.comment.entity.Comment;
import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

/** 목록·집계의 부모 조건은 서비스 사전 검사 후 숨김이 확정된 경우 조회 시점에 다시 거른다. */
public interface CommentRepository extends JpaRepository<Comment, Long> {
    @Query("select count(c) from Comment c where c.post.id=:postId and c.status='visible' and c.post.status='visible'")
    int countVisibleByVisiblePostId(long postId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select c from Comment c where c.id = :id")
    Optional<Comment> findByIdForUpdate(long id);

    /**
     * 최신순 첫 페이지. 작성자는 to-one이라 LIMIT이 SQL로 내려가며
     * {@code ix_comments_post_created}를 역방향으로 읽어 요청한 만큼만 가져온다.
     */
    @Query("""
            select c from Comment c join fetch c.author
             where c.post.id = :postId and c.status = 'visible' and c.post.status = 'visible'
             order by c.createdAt desc, c.id desc
            """)
    List<Comment> findVisibleFirstPage(long postId, Pageable pageable);

    /**
     * 커서 이후 한 페이지. 이어읽기 조건은 정렬과 같은 순서로 두 키를 함께 본다.
     * 같은 시각에 만들어진 댓글이 있으면 시각만 비교했을 때 통째로 밀리거나 빠지기 때문이다.
     *
     * <p>첫 페이지를 따로 둔 이유는 PostgreSQL이 {@code ? is null} 형태에서 파라미터 타입을
     * 추론하지 못해 실패하기 때문이다. null을 넘기지 않으면 캐스팅도 필요 없다.
     */
    @Query("""
            select c from Comment c join fetch c.author
             where c.post.id = :postId and c.status = 'visible' and c.post.status = 'visible'
               and (c.createdAt < :afterCreatedAt
                    or (c.createdAt = :afterCreatedAt and c.id < :afterId))
             order by c.createdAt desc, c.id desc
            """)
    List<Comment> findVisibleAfter(long postId, Instant afterCreatedAt, long afterId, Pageable pageable);
}
