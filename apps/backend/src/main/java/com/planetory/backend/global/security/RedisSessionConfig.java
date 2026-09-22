package com.planetory.backend.global.security;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.serializer.JdkSerializationRedisSerializer;
import org.springframework.data.redis.serializer.StringRedisSerializer;
import org.springframework.session.config.annotation.web.http.EnableSpringHttpSession;
import org.springframework.session.data.redis.RedisSessionRepository;
import org.springframework.session.web.http.DefaultCookieSerializer;
import org.springframework.session.web.http.SessionRepositoryFilter;

@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@ConditionalOnProperty(name = "planetory.session.redis.enabled", havingValue = "true", matchIfMissing = true)
@EnableSpringHttpSession
public class RedisSessionConfig {
    @Bean LettuceConnectionFactory sessionRedisConnectionFactory(Environment env) {
        return connection(env, "session");
    }
    @Bean @Primary LettuceConnectionFactory redisConnectionFactory(Environment env) {
        if (env.getRequiredProperty("planetory.redis.session.host").equals(env.getRequiredProperty("planetory.redis.cache.host"))
                && env.getRequiredProperty("planetory.redis.session.port").equals(env.getRequiredProperty("planetory.redis.cache.port"))) {
            throw new IllegalArgumentException("Session and cache Redis must use separate instances");
        }
        return connection(env, "cache");
    }
    private LettuceConnectionFactory connection(Environment env, String purpose) {
        String prefix = "planetory.redis." + purpose + ".";
        var server = new RedisStandaloneConfiguration(env.getRequiredProperty(prefix + "host"),
                env.getRequiredProperty(prefix + "port", Integer.class));
        String password = env.getProperty(prefix + "password");
        if (password != null && !password.isBlank()) server.setPassword(password);
        var options = io.lettuce.core.ClientOptions.builder().socketOptions(io.lettuce.core.SocketOptions.builder()
                .connectTimeout(Duration.ofSeconds(2)).build()).build();
        var client = LettuceClientConfiguration.builder().clientOptions(options).commandTimeout(Duration.ofSeconds(2))
                .shutdownTimeout(Duration.ZERO).build();
        return new LettuceConnectionFactory(server, client);
    }
    @Bean RedisSessions<?> sessionRepository(
            @Qualifier("sessionRedisConnectionFactory") LettuceConnectionFactory connection) {
        var template = new RedisTemplate<String, Object>();
        template.setConnectionFactory(connection);
        template.setKeySerializer(new StringRedisSerializer());
        template.setHashKeySerializer(new StringRedisSerializer());
        template.setDefaultSerializer(new JdkSerializationRedisSerializer());
        template.afterPropertiesSet();
        var repository = new RedisSessionRepository(template);
        repository.setRedisKeyNamespace("planetory:session");
        repository.setDefaultMaxInactiveInterval(Duration.ofMinutes(30));
        repository.setFlushMode(org.springframework.session.FlushMode.ON_SAVE);
        repository.setSaveMode(org.springframework.session.SaveMode.ON_SET_ATTRIBUTE);
        return new RedisSessions<>(repository);
    }
    @Bean DefaultCookieSerializer cookieSerializer(Environment env) {
        var cookie = new DefaultCookieSerializer();
        cookie.setCookieName("SESSION");
        cookie.setCookiePath("/");
        cookie.setUseHttpOnlyCookie(true);
        cookie.setUseSecureCookie(env.getProperty("server.servlet.session.cookie.secure", Boolean.class, true));
        cookie.setSameSite("Lax");
        return cookie;
    }
    @Bean FilterRegistrationBean<SessionDependencyFilter> sessionDependencyFilter(SecurityErrorWriter errors) {
        var registration = new FilterRegistrationBean<>(new SessionDependencyFilter(errors));
        registration.setOrder(SessionRepositoryFilter.DEFAULT_ORDER - 1);
        return registration;
    }
}
