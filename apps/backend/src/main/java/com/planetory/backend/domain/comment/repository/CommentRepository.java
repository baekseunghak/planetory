package com.planetory.backend.domain.comment.repository;

import com.planetory.backend.domain.comment.entity.Comment;
import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface CommentRepository extends JpaRepository<Comment, Long> {
    int countByPostIdAndStatus(long postId, String status);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select c from Comment c where c.id = :id")
    Optional<Comment> findByIdForUpdate(long id);

    /**
     * 최신순 한 페이지. 작성자는 to-one이라 LIMIT이 SQL로 내려가며
     * {@code ix_comments_post_created}를 역방향으로 읽어 요청한 만큼만 가져온다.
     */
    @Query("""
            select c from Comment c join fetch c.author
             where c.post.id = :postId and c.status = 'visible'
             order by c.createdAt desc, c.id desc
            """)
    List<Comment> findVisibleByPostId(long postId, Pageable pageable);
}
